import { execFile, spawn } from "node:child_process";
import { fstatSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { shellQuote } from "./external.ts";
import {
  isRemoteTmuxTarget,
  type AgentTarget,
  type RemoteTmuxTarget,
} from "./remote-target.ts";
import { isTmuxTarget, tmuxPresence, type TmuxTarget } from "./tmux-target.ts";

const { remoteConfig, SSH_OPTIONS, remote, remoteTmuxAttachArgs } =
  await import(
    new URL(
      "../../bin/dev01.mjs",
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
    ).href
  );

export type AgentOpener = (
  target: AgentTarget,
  signal: AbortSignal,
) => Promise<void | "window" | "switched">;

interface LocalIdentity {
  pid: string;
  session: string;
  window: string;
  pane: string;
  tty: string;
  linked: string;
}

const moved = "That tmux agent moved or exited. Refresh /agents.";
const command = (args: string[]) => args.map(shellQuote).join(" ");
const paneTarget = (identity: LocalIdentity) =>
  `${identity.session}:${identity.window}.${identity.pane}`;
const identityGuard = (identity: LocalIdentity) =>
  `#{==:#{pid} #{session_id} #{window_id} #{pane_id} #{window_linked},${identity.pid} ${identity.session} ${identity.window} ${identity.pane} ${identity.linked}}`;

// -F executes synchronously in tmux's command queue, without a shell or a gap
// between checking ownership and selecting/attaching the exact pane.
function guarded(
  identity: LocalIdentity,
  action: string,
  condition = identityGuard(identity),
): string[] {
  return [
    "if-shell",
    "-F",
    "-t",
    identity.pane,
    condition,
    action,
    command(["display-message", "-p", moved]),
  ];
}

function tmuxArgs(target: TmuxTarget, identity: LocalIdentity): string[] {
  return [
    "-S",
    target.socket,
    ...guarded(
      identity,
      command(["attach-session", "-t", paneTarget(identity)]),
    ),
  ];
}

async function localIdentity(
  socket: string,
  target: string,
  signal: AbortSignal,
): Promise<LocalIdentity> {
  const fields = (
    await exec(
      "tmux",
      [
        "-S",
        socket,
        "display-message",
        "-p",
        "-t",
        target,
        "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_tty}\t#{window_linked}",
      ],
      signal,
    )
  ).split("\t");
  const [pid, session, window, pane, tty, linked] = fields;
  if (
    fields.length !== 6 ||
    !/^[1-9]\d*$/.test(pid) ||
    !isTmuxTarget({ socket, session, pane }) ||
    !/^@\d+$/.test(window) ||
    !/^\/dev\/[\w/.-]+$/.test(tty) ||
    !/^[01]$/.test(linked)
  )
    throw new Error(moved);
  return { pid, session, window, pane, tty, linked };
}

function exec(
  file: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
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
        else resolve(stdout.trim());
      },
    );
  });
}

function identityCommand(target: RemoteTmuxTarget): string {
  return `tmux -S ${shellQuote(target.socket)} display-message -p -t ${shellQuote(target.pane)} '#{session_id} #{pane_id}'`;
}

/** Fixed SSH transport and structured targets only. Never execute nativeCommand. */
export function remoteAttachCommand(target: RemoteTmuxTarget): string {
  if (!isRemoteTmuxTarget(target))
    throw new Error("Invalid remote tmux target.");
  return `exec tmux ${remoteTmuxAttachArgs(target).map(shellQuote).join(" ")}`;
}

function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Opening an agent requires an interactive terminal.");
}

/** Release only the terminal. The parent runtime and the agent keep running. */
async function handoff(
  tui: TUI,
  file: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  tui.stop();
  try {
    process.stdout.write("\x1b[2J\x1b[H");
    await new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.TMUX;
      delete env.TMUX_PANE;
      const child = spawn(file, args, { stdio: "inherit", env });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (signal.aborted) reject(new Error("Opening cancelled."));
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              `${file} attach exited with code ${code ?? "unknown"}. The agent was not stopped.`,
            ),
          );
      });
    });
  } finally {
    if (!signal.aborted) {
      tui.start();
      tui.requestRender(true);
    }
  }
}

export async function attachTmux(
  tui: TUI,
  target: TmuxTarget,
  signal: AbortSignal,
): Promise<void | "window" | "switched"> {
  if (!isTmuxTarget(target) || "host" in target || "sshHost" in target)
    throw new Error("Invalid local tmux target.");
  requireTerminal();
  const identity = await localIdentity(
    target.socket,
    target.pane || target.session,
    signal,
  );
  if (
    identity.session !== target.session ||
    (target.pane && identity.pane !== target.pane)
  )
    throw new Error(moved);
  if (!process.env.TMUX && !process.env.TMUX_PANE) {
    await handoff(tui, "tmux", tmuxArgs(target, identity), signal);
    return;
  }

  const current = tmuxPresence();
  if (!current)
    throw new Error("Cannot verify the dashboard's local tmux pane.");
  const origin = await localIdentity(current.socket, current.pane, signal);
  if (
    origin.pane !== current.pane ||
    origin.linked !== "0" ||
    origin.pid !== process.env.TMUX?.match(/,(\d+),\d+$/)?.[1] ||
    statSync(origin.tty).rdev !== fstatSync(process.stdin.fd).rdev ||
    statSync(origin.tty).rdev !== fstatSync(process.stdout.fd).rdev
  )
    throw new Error("Cannot verify the dashboard's local tmux terminal.");
  const clients = await exec(
    "tmux",
    [
      "-S",
      current.socket,
      "list-clients",
      "-t",
      origin.session,
      "-F",
      "#{client_name}\t#{client_pid}\t#{session_id}\t#{pane_id}\t#{client_control_mode}\t#{client_flags}",
    ],
    signal,
  );
  const [name, pid, session, pane, control, flags = ""] = clients.split("\t");
  if (
    clients.includes("\n") ||
    !/^\/dev\/[\w/.-]+$/.test(name) ||
    !/^[1-9]\d*$/.test(pid) ||
    session !== origin.session ||
    pane !== origin.pane ||
    control !== "0" ||
    flags.split(",").includes("active-pane")
  )
    throw new Error(
      "Cannot identify one dashboard tmux client. Multiple clients are ambiguous.",
    );

  // Recheck the sole client too. Never let tmux choose the most recent client,
  // or switch one that moved elsewhere while these read-only probes ran.
  const owner = `#{L:#{?#{==:#{client_name},${name}},#{client_pid}:#{client_control_mode}:#{m:*active-pane*,#{client_flags}},}}`;
  const sourceGuard = `#{&&:${identityGuard(origin)},#{&&:#{==:#{session_attached} #{session_attached_list} #{window_active} #{pane_active},1 ${name} 1 1},#{==:${owner},${pid}:0:0}}}`;
  const sameServer = origin.pid === identity.pid;
  const result = sameServer ? "switched" : "window";
  const action = sameServer
    ? command(
        guarded(
          identity,
          command(["switch-client", "-c", name, "-t", paneTarget(identity)]),
        ),
      )
    : command([
        "new-window",
        "-t",
        origin.session,
        "-n",
        "agent",
        "env",
        "-u",
        "TMUX",
        "-u",
        "TMUX_PANE",
        "tmux",
        ...tmuxArgs(target, identity),
      ]);
  const output = await exec(
    "tmux",
    [
      "-S",
      current.socket,
      ...guarded(
        origin,
        `${action} ; display-message -p ${result}`,
        sourceGuard,
      ),
    ],
    signal,
  );
  if (output !== result) throw new Error(moved);
  return result;
}

export async function attachAgent(
  tui: TUI,
  target: AgentTarget,
  signal: AbortSignal,
): Promise<void | "window" | "switched"> {
  if (!("host" in target) && !("sshHost" in target))
    return attachTmux(tui, target, signal);
  if (!isRemoteTmuxTarget(target))
    throw new Error("Invalid remote tmux target.");
  const { host } = remoteConfig();
  if (target.sshHost !== host)
    throw new Error("Remote SSH destination changed. Refresh /agents.");
  requireTerminal();
  signal.throwIfAborted();
  const command = remoteAttachCommand(target);
  // Fail before opening a terminal/window, then check again on the owning host
  // immediately before attach. Never reinterpret a stale numeric ID as a name.
  const { stdout } = await remote(identityCommand(target), {
    sshHost: host,
    signal,
    timeout: 10_000,
  });
  if (stdout.trim() !== `${target.session} ${target.pane}`)
    throw new Error("That remote tmux agent moved or exited. Refresh /agents.");
  signal.throwIfAborted();
  const args = [...SSH_OPTIONS, "-t", host, command];
  if (process.env.TMUX) {
    const current = tmuxPresence();
    if (!current)
      throw new Error("Cannot verify the dashboard's local tmux pane.");
    const session = await exec(
      "tmux",
      [
        "-S",
        current.socket,
        "display-message",
        "-p",
        "-t",
        current.pane,
        "#{session_id}",
      ],
      signal,
    );
    if (!/^\$\d+$/.test(session) || /\s/.test(session))
      throw new Error("Cannot verify the dashboard's local tmux session.");
    // tmux's multi-argument command form avoids a local shell. Keep the dashboard
    // and SSH in separate windows so the outer prefix remains the return path.
    await exec(
      "tmux",
      [
        "-S",
        current.socket,
        "new-window",
        "-t",
        session,
        "-n",
        "dev01",
        "ssh",
        ...args,
      ],
      signal,
    );
    return "window";
  }
  await handoff(tui, "ssh", args, signal);
}
