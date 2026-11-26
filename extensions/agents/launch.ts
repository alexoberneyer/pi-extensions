import { realpathSync } from "node:fs";
import { expandPath } from "../../lib/config.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import { DISCOVERY_TIMEOUT_MS, type SessionAdapter } from "./external.ts";
import { createLocalTmuxAdapter, mergeLocalTmux } from "./local-tmux.ts";
import type { RemoteTmuxTarget } from "./remote-target.ts";
import type { AgentRow, Presence } from "./state.ts";
import type { TmuxTarget } from "./tmux-target.ts";

const root = new URL(
  "../../bin/",
  pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
);
const { startInteractiveWithTarget } = await import(
  new URL("dev01.mjs", root).href
);
const {
  launchLocal,
  isResumeId: validResumeId,
  resumeSessionName,
} = await import(new URL("agent-launch.mjs", root).href);

export const agents = ["pi", "claude", "codex"] as const;
export type LaunchAgent = (typeof agents)[number];
export type ResumeAgent = Exclude<LaunchAgent, "pi">;
export { resumeSessionName };

export function isResumeId(value: unknown): value is string {
  return validResumeId(value);
}

export function isResumeAgent(
  agent: LaunchAgent | "tmux",
): agent is ResumeAgent {
  return agent === "claude" || agent === "codex";
}
export interface LaunchRequest {
  host: "local" | "dev01";
  agent: LaunchAgent;
  cwd: string;
  name: string;
  resumeId?: string;
  confirmUnverified?: boolean;
}
export interface LaunchResult {
  message: string;
  attachCommand?: string;
  tmux?: TmuxTarget;
  remoteTmux?: RemoteTmuxTarget;
}
export type Launcher = (
  request: LaunchRequest,
  signal: AbortSignal,
) => Promise<LaunchResult | { needsConfirmation: true }>;

export function localProject(value: string, cwd: string): string {
  return expandPath(value, cwd);
}

export function validateLaunch(request: LaunchRequest): void {
  if (
    !["local", "dev01"].includes(request.host) ||
    !agents.includes(request.agent)
  )
    throw new Error("Choose a supported host and agent.");
  if (request.resumeId !== undefined) {
    if (request.host !== "local" || !isResumeAgent(request.agent))
      throw new Error("Resume is available for local Claude and Codex only.");
    if (!isResumeId(request.resumeId))
      throw new Error("Enter the full session ID (UUID).");
  }
  if (
    !request.cwd.trim() ||
    /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(
      request.cwd,
    )
  )
    throw new Error("Choose a project path without control characters.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.name))
    throw new Error(
      "Job name: lowercase a-z, 0-9 and hyphens, at most 64 characters.",
    );
}

export function resumeDisposition(
  agent: ResumeAgent,
  id: string,
  name: string,
  native: AgentRow[] | undefined,
  panes: AgentRow[] | undefined,
): { target?: TmuxTarget; uncertain?: boolean } {
  const key = id.toLowerCase();
  const matches = (native ?? []).filter(
    (row) =>
      !row.host &&
      row.source === agent &&
      (row.nativeId?.toLowerCase() === key ||
        row.transcriptId?.toLowerCase() === key),
  );
  const marked = (panes ?? []).filter(
    (row) =>
      !row.host &&
      row.tmuxAgent === agent &&
      row.tmuxResume === name &&
      row.tmux?.pane,
  );
  const live = matches.filter((row) => row.live);
  if (marked.length > 1 || live.length > 1)
    throw new Error(
      "More than one terminal matches this session. Use its original terminal.",
    );
  const [existing] = marked;
  const [running] = live;
  if (running) {
    const verified = mergeLocalTmux([running, ...(panes ?? [])]).find(
      (row) => row.key === running.key,
    )?.tmux;
    if (
      verified &&
      existing?.live &&
      (verified.socket !== existing.tmux?.socket ||
        verified.pane !== existing.tmux?.pane)
    )
      throw new Error(
        "More than one terminal matches this session. Use its original terminal.",
      );
    if (verified) return { target: verified };
    if (!existing?.live)
      throw new Error(
        "This session is already open. Use its original terminal or the native action in Agents.",
      );
  }
  if (existing?.live) return { target: existing.tmux };
  if (existing)
    throw new Error(
      "The last resume exited. Inspect its tmux pane in Agents, then close it before retrying.",
    );
  return { uncertain: !native || !panes || matches.length > 0 };
}

async function freshRows(adapter: SessionAdapter, signal: AbortSignal) {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(adapter.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
  ]);
  try {
    const rows = await adapter.list(deadline);
    deadline.throwIfAborted();
    return rows;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

export const launchAgent = async (
  request: LaunchRequest,
  signal: AbortSignal,
  presence: () => Presence[] = () => [],
): ReturnType<Launcher> => {
  validateLaunch(request);
  signal.throwIfAborted();
  if (request.host === "dev01") {
    const result = await startInteractiveWithTarget(request.name, {
      agent: request.agent,
      cwd: request.cwd,
      signal,
    });
    return {
      message: result.message,
      attachCommand: result.attachCommand,
      remoteTmux: result.remoteTmux,
    };
  }
  if (request.resumeId !== undefined && isResumeAgent(request.agent)) {
    const { agent, resumeId } = request;
    const [native, panes] = await Promise.all([
      freshRows(
        agent === "claude" ? createClaudeAdapter() : createCodexAdapter(),
        signal,
      ),
      freshRows(createLocalTmuxAdapter(presence), signal),
    ]);
    signal.throwIfAborted();
    const { target, uncertain } = resumeDisposition(
      agent,
      resumeId,
      resumeSessionName(agent, resumeId),
      native,
      panes,
    );
    if (target)
      return { tmux: target, message: "Opening the existing tmux session." };
    if (uncertain && !request.confirmUnverified)
      return { needsConfirmation: true };
  }
  return launchLocal({ ...request, terminal: "tmux", task: "" }, signal);
};
