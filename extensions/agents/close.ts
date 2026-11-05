import { execFile } from "node:child_process";
import { pathKey } from "./state.ts";
import { isTmuxTarget, tmuxPresence, type TmuxTarget } from "./tmux-target.ts";

export type PaneCloser = (
  target: TmuxTarget,
  signal: AbortSignal,
) => Promise<void>;

export function assertCloseablePane(
  target: TmuxTarget,
): asserts target is TmuxTarget & { pane: string } {
  if (!isTmuxTarget(target) || !target.pane)
    throw new Error("Closing requires an exact local tmux pane.");
  const current = tmuxPresence();
  if (process.env.TMUX && !current)
    throw new Error("Cannot verify the dashboard's own tmux pane.");
  if (
    current &&
    current.pane === target.pane &&
    pathKey(current.socket) === pathKey(target.socket)
  )
    throw new Error("Cannot close the pane containing this dashboard.");
}

/** Call only after confirmation. No session kill, shell execution or history deletion. */
export async function closeTmuxPane(
  target: TmuxTarget,
  signal: AbortSignal,
): Promise<void> {
  assertCloseablePane(target);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "tmux",
      [
        "-S",
        target.socket,
        "if-shell",
        "-F",
        "-t",
        target.pane,
        `#{==:#{session_id},${target.session}}`,
        `kill-pane -t ${target.pane}`,
        'display-message -p "Pane moved or exited. Refresh /agents."',
      ],
      {
        signal,
        timeout: 4_000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 4_096,
      },
      (error, stdout) => {
        if (signal.aborted) child.kill("SIGKILL");
        if (error) reject(error);
        else if (stdout.trim()) reject(new Error(stdout.trim()));
        else resolve();
      },
    );
  });
}
