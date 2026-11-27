import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { permitted, toolsFor } from "./triage-guard.mjs";
import { clean } from "./state.ts";

const MAX_OUTPUT = 16 * 1024 * 1024;
const guard = realpathSync(
  fileURLToPath(new URL("./triage-guard.mjs", import.meta.url)),
);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
type Pass = {
  mode: "triage" | "mail" | "teams";
  label: string;
  instructions: string;
  schema: object;
  maxTurns: number;
  model: string;
  effort: "medium" | "high";
};
export function claudeArgs(pass: Pass): string[] {
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--tools",
    "ToolSearch",
    "--allowedTools",
    toolsFor(pass.mode).join(","),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--model",
    pass.model,
    "--effort",
    pass.effort,
    "--max-turns",
    String(pass.maxTurns),
    "--json-schema",
    JSON.stringify(pass.schema),
    "--settings",
    JSON.stringify({
      disableAllHooks: false,
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: `${quote(process.execPath)} ${quote(guard)}${pass.mode === "triage" ? "" : ` ${quote(pass.mode)}`}`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    }),
    "--append-system-prompt",
    pass.instructions,
  ];
}

export type ClaudeProcess = {
  cwd: string;
  signal: AbortSignal;
  progress: (text: string) => void;
};
export async function runClaude(
  pass: Pass,
  request: ClaudeProcess,
  prompt: string,
  timeout: number,
): Promise<{ output: unknown; reads: Set<string> }> {
  request.signal.throwIfAborted();
  const { label, mode } = pass;
  const unchanged =
    mode === "triage"
      ? "Nothing imported; checkpoints unchanged."
      : "Local draft unchanged.";
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  delete env.CLAUDECODE;
  // The user's Claude auth/MCP settings stay in Claude. No credential copying,
  // second MCP client, shell prompt interpolation or permissions bypass.
  return new Promise((resolve, reject) => {
    const child = spawn("claude", claudeArgs(pass), {
      cwd: request.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let buffer = "",
      bytes = 0;
    let final: Record<string, unknown> | undefined;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let calls = 0;
    const readCalls = new Map<string, string>();
    const reads = new Set<string>();
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process group already exited. */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    const abort = () => stop(new Error(`${label} cancelled. ${unchanged}`));
    const timer = setTimeout(
      () => stop(new Error(`${label} reached its time limit. ${unchanged}`)),
      timeout,
    );
    timer.unref();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const event = (line: string) => {
      if (!line.trim()) return;
      const value = JSON.parse(line);
      if (value.type === "assistant") {
        for (const block of value.message?.content || []) {
          if (block.type !== "tool_use") continue;
          if (!permitted(block.name, block.input, mode)) {
            // Also stop at the stream boundary, independently of the tool hook.
            stop(
              new Error(
                `Claude requested a tool outside the Comms read allowlist. ${unchanged}`,
              ),
            );
            return;
          }
          if (
            mode !== "triage" &&
            block.name.startsWith("mcp__") &&
            typeof block.id === "string"
          )
            readCalls.set(block.id, block.name);
          request.progress(
            `${label} · ${++calls} tool calls · ${clean(block.name, 120)}`,
          );
        }
      }
      if (mode !== "triage" && value.type === "user") {
        for (const block of value.message?.content || []) {
          if (block.type !== "tool_result") continue;
          const name = readCalls.get(block.tool_use_id);
          if (name && !block.is_error && block.content?.length) reads.add(name);
        }
      }
      if (value.type === "result") {
        if (final)
          throw new Error("Claude returned more than one final result.");
        final = value;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) {
        stop(new Error(`${label} exceeded its output limit. ${unchanged}`));
        return;
      }
      buffer += chunk;
      let end: number;
      try {
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          event(line);
        }
      } catch {
        stop(
          new Error(`Claude returned an invalid event stream. ${unchanged}`),
        );
      }
    });
    // Drain but never persist or expose arbitrary connector diagnostics, which
    // can contain private content. Failures get a bounded, generic UI message.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () =>
      stop(new Error(`Claude did not accept the Comms request. ${unchanged}`)),
    );
    child.on("error", (error) =>
      stop(
        new Error(
          `Cannot start ${label} (${(error as NodeJS.ErrnoException).code || "process error"}). Check that claude is installed and signed in.`,
        ),
      ),
    );
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      request.signal.removeEventListener("abort", abort);
      try {
        // The leader may exit while a same-group MCP/helper process ignores
        // SIGTERM. Kill and reap the owned group before settling or unlocking.
        kill("SIGKILL");
        if (child.pid && process.platform !== "win32") {
          let gone = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              process.kill(-child.pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                gone = true;
                break;
              }
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!gone)
            throw new Error(
              "Claude's owned process group did not finish cleanup. Inspect its processes before retrying.",
            );
        }
        if (failure) throw failure;
        if (buffer.trim()) event(buffer);
        if (failure) throw failure;
        if (
          code !== 0 ||
          !final ||
          final.is_error ||
          final.subtype !== "success"
        )
          throw new Error(
            `${label} failed (${final?.subtype || `exit ${code}`}). Check Claude authentication or limits. ${unchanged}`,
          );
        if (
          Array.isArray(final.permission_denials) &&
          final.permission_denials.length
        )
          throw new Error(
            `${label} encountered denied tool calls. ${unchanged}`,
          );
        resolve({ output: final.structured_output, reads });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}
