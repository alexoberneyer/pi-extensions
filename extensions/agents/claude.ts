import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import {
  identifier,
  nativeCommand,
  object,
  shellQuote,
  type SessionAdapter,
} from "./external.ts";
import { pathKey, plain, type AgentRow, type Status } from "./state.ts";

export function claudeRows(
  value: unknown,
  configDir?: string,
  remote = false,
): AgentRow[] {
  if (!Array.isArray(value)) throw new Error("Unsupported Claude session list");
  const rows = new Map<string, AgentRow>();
  for (const item of value) {
    const session = object(item);
    if (!session) continue;
    const id = session.sessionId ?? session.id;
    if (
      !identifier(id) ||
      typeof session.cwd !== "string" ||
      !isAbsolute(session.cwd)
    )
      continue;
    const cwd = session.cwd;
    const background = session.kind === "background";
    const pid =
      typeof session.pid === "number" &&
      Number.isSafeInteger(session.pid) &&
      session.pid > 0
        ? session.pid
        : undefined;
    const live = pid !== undefined;
    // status describes the live process. state describes the background job.
    // In particular, a job marked done may still have an idle live process.
    const status: Status =
      session.status === "waiting"
        ? "waiting"
        : session.status === "busy"
          ? "working"
          : session.status === "idle"
            ? "ready"
            : session.state === "blocked"
              ? "waiting"
              : "unknown";
    const attachId = identifier(session.id) ? session.id : id;
    const command = background
      ? nativeCommand(() => {
          const env = configDir
            ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} `
            : "";
          return `cd -- ${shellQuote(cwd)} && ${env}claude attach ${shellQuote(attachId)}`;
        })
      : undefined;
    const detail = [
      `Claude ${background ? "background" : "interactive"}`,
      live ? `PID ${pid}` : "No live PID reported",
      `Native status: ${plain(String(session.status ?? "unknown"), 50)}`,
      ...(typeof session.state === "string"
        ? [`job: ${plain(session.state, 50)}`]
        : []),
      background ? "Enter shows attach command" : "Use its original terminal",
    ].join(" · ");
    rows.set(`claude:${id}`, {
      source: "claude",
      key: `claude:${id}`,
      live,
      pid,
      cwd: remote ? cwd : pathKey(cwd),
      title:
        (typeof session.name === "string" && plain(session.name, 160)) ||
        plain(`Claude in ${basename(cwd) || cwd}`, 160),
      preview:
        typeof session.waitingFor === "string" ? plain(session.waitingFor) : "",
      model: "",
      status,
      // The CLI does not always expose an activity timestamp. Do not present
      // process start time or time of polling as the session's last activity.
      updated:
        typeof session.statusUpdatedAt === "number" &&
        Number.isFinite(session.statusUpdatedAt)
          ? session.statusUpdatedAt
          : 0,
      current: false,
      owners: [],
      detail,
      nativeCommand: command,
    });
  }
  if (value.length && !rows.size)
    throw new Error("Unsupported Claude session records");
  return [...rows.values()];
}

export function createClaudeAdapter(): SessionAdapter {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return {
    source: "claude",
    async list(signal) {
      signal.throwIfAborted();
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "claude",
          ["agents", "--json"],
          {
            cwd: homedir(),
            signal,
            killSignal: "SIGKILL", // Only the short-lived discovery helper, never a session.
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout) => {
            // execFile does not forward killSignal to its AbortSignal handler.
            // Stop this discovery helper even if it ignores the initial SIGTERM.
            if (signal.aborted) child.kill("SIGKILL");
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
      return claudeRows(JSON.parse(output), configDir);
    },
  };
}
