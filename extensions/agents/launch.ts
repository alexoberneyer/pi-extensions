import { realpathSync } from "node:fs";
import { expandPath } from "../../lib/config.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RemoteTmuxTarget } from "./remote-target.ts";
import type { TmuxTarget } from "./tmux-target.ts";

const root = new URL(
  "../../bin/",
  pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
);
const { startInteractiveWithTarget } = await import(
  new URL("dev01.mjs", root).href
);
const { launchLocal } = await import(new URL("agent-launch.mjs", root).href);

export const agents = ["pi", "claude", "codex"] as const;
export type LaunchAgent = (typeof agents)[number];
export interface LaunchRequest {
  host: "local" | "dev01";
  agent: LaunchAgent;
  cwd: string;
  name: string;
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
) => Promise<LaunchResult>;

export function localProject(value: string, cwd: string): string {
  return expandPath(value, cwd);
}

export function validateLaunch(request: LaunchRequest): void {
  if (
    !["local", "dev01"].includes(request.host) ||
    !agents.includes(request.agent)
  )
    throw new Error("Choose a supported host and agent.");
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

export const launchAgent: Launcher = async (request, signal) => {
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
  return launchLocal({ ...request, terminal: "tmux", task: "" }, signal);
};
