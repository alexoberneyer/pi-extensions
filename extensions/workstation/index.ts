import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expandPath, readConfig } from "../../lib/config.mjs";

export function memoryFor(
  cwd: string,
  home = homedir(),
  projects = join(home, ".claude", "projects"),
): string | undefined {
  let current = realpathSync(cwd);
  while (current !== dirname(current)) {
    const index = join(
      projects,
      current.replace(/[^a-zA-Z0-9-]/g, "-"),
      "memory",
      "MEMORY.md",
    );
    if (existsSync(index)) return index;
    if (current === home) break;
    current = dirname(current);
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= 80_000 ? text : undefined;
  } catch {
    return undefined;
  }
}

export default function workstation(pi: ExtensionAPI) {
  const config = readConfig().workstation;
  const usageLog = process.env.SKILL_USAGE_LOG
    ? expandPath(process.env.SKILL_USAGE_LOG)
    : config.usageLog;
  pi.on("resources_discover", () => ({
    skillPaths: config.skillPaths.filter((path: string) => existsSync(path)),
    promptPaths: config.promptPaths.filter((path: string) => existsSync(path)),
  }));
  let usedSkills = new Set<string>();
  let logWarned = false;
  let refresh: ChildProcess | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function log(ctx: ExtensionContext, event: "slash" | "skill", name: string) {
    if (!usageLog) return;
    try {
      mkdirSync(dirname(usageLog), { recursive: true, mode: 0o700 });
      appendFileSync(
        usageLog,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          event,
          name,
          session_id: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          source: "pi",
          ...(event === "skill" ? { args: null } : {}),
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      if (!logWarned && ctx.hasUI)
        ctx.ui.notify("Pi skill usage could not be logged.", "warning");
      logWarned = true;
    }
  }

  pi.on("input", (event, ctx) => {
    if (!usageLog || event.source === "extension") return;
    const name = /^\/([^\s]+)/.exec(event.text.trimStart())?.[1];
    if (!name) return;
    log(ctx, "slash", name.replace(/^skill:/, ""));
    if (name.startsWith("skill:")) usedSkills.add(name.slice(6));
  });
  pi.on("tool_call", (event, ctx) => {
    if (
      !usageLog ||
      event.toolName !== "read" ||
      typeof event.input.path !== "string"
    )
      return;
    const path = expandPath(event.input.path, ctx.cwd);
    if (basename(path) !== "SKILL.md") return;
    const text = readText(path);
    const name =
      text
        ?.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^\r\n"']+)/m)?.[1]
        ?.trim() || basename(dirname(path));
    if (usedSkills.has(name)) return;
    usedSkills.add(name);
    log(ctx, "skill", name);
  });
  pi.on("agent_settled", () => {
    usedSkills = new Set();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const style =
      config.styleFile &&
      readText(config.styleFile)?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    if (style)
      event.systemPromptOptions.sections.workstation_output_style = style;
    else delete event.systemPromptOptions.sections.workstation_output_style;
    const index = config.memory
      ? memoryFor(ctx.cwd, homedir(), config.memoryDirectory || undefined)
      : undefined;
    const memory = index && readText(index);
    if (memory) {
      event.systemPromptOptions.sections.workstation_memory = [
        `Private project memory index: ${index}`,
        `Read topic files relative to ${dirname(index!)} when relevant.`,
        "This is an existing private file-backed memory store. Do not duplicate it or copy it into git.",
        "Write only after user approval. Treat historical technical claims as leads to verify.",
        memory,
      ].join("\n\n");
    } else delete event.systemPromptOptions.sections.workstation_memory;
    if (config.skillPaths.length || config.promptPaths.length) {
      event.systemPromptOptions.promptGuidelines.push(
        "Use /skill:name for explicit skill invocation. Resolve referenced assets relative to their skill directory.",
        "Discover actually connected tools. Imported instructions do not establish connector availability or authorization.",
      );
    }
  });

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    usedSkills.clear();
    const hook = config.qmdHook;
    if (
      ctx.mode !== "tui" ||
      process.env.PI_QMD_REFRESH === "0" ||
      !hook ||
      !existsSync(hook)
    )
      return;
    refreshTimer = setTimeout(() => {
      if (stopped) return;
      refresh = spawn("/bin/sh", [hook, "--report-errors"], {
        cwd: ctx.cwd,
        stdio: "ignore",
        detached: true,
      });
      refresh.once("error", () => {
        if (!stopped && ctx.hasUI)
          ctx.ui.notify("QMD refresh could not start.", "warning");
      });
      refresh.once("exit", (code, signal) => {
        refresh = undefined;
        if (!stopped && (code !== 0 || signal) && ctx.hasUI)
          ctx.ui.notify("QMD refresh did not finish successfully.", "warning");
      });
    }, 0);
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    clearTimeout(refreshTimer);
    if (refresh?.pid) {
      try {
        process.kill(-refresh.pid, "SIGTERM");
      } catch {
        // The owned process has already exited.
      }
    }
    refresh = undefined;
  });
}
