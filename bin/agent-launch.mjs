// Local launcher and terminal runner. Importing performs no I/O.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote, runProcess } from "./dev01.mjs";

export const GHOSTTY_SCRIPT = `on run argv
  tell application id "com.mitchellh.ghostty"
    set config to new surface configuration
    set initial working directory of config to item 1 of argv
    set command of config to item 2 of argv
    set wait after command of config to true
    set createdWindow to new window with configuration config
    return id of createdWindow
  end tell
end run`;

export function isResumeId(value) {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  );
}

const profileKeys = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
};

function agentProfile(agent) {
  const key = profileKeys[agent];
  const value = process.env[key];
  return { key, path: value ? resolve(value) : null };
}

export function resumeSessionName(agent, id) {
  const profile = agentProfile(agent);
  let root = profile.path ?? join(homedir(), `.${agent}`);
  try {
    root = realpathSync(root);
  } catch {
    // The native CLI can report a missing profile.
  }
  const hash = createHash("sha256")
    .update(`${agent}\0${root}\0${id.toLowerCase()}`)
    .digest("hex");
  return `job-${hash.slice(0, 32)}`;
}

function splitOrigin() {
  const match = process.env.TMUX?.match(/^(.*),([1-9]\d*),(\d+)$/);
  const pane = process.env.TMUX_PANE;
  if (
    !match ||
    !isAbsolute(match[1]) ||
    /[\x00-\x1f\x7f]/.test(match[1]) ||
    !/^%\d+$/.test(pane || "") ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    return undefined;
  return { socket: match[1], pid: match[2], session: `$${match[3]}`, pane };
}

export function canLaunchSplit() {
  return process.platform === "darwin" && Boolean(splitOrigin());
}

export async function launchLocal(
  { agent, cwd, task, terminal = "ghostty", name, resumeId },
  signal,
) {
  if (process.platform !== "darwin")
    throw new Error("Local launching requires macOS.");
  if (!["pi", "claude", "codex"].includes(agent))
    throw new Error("Unknown agent. Use pi, claude or codex.");
  if (!["ghostty", "tmux", "split"].includes(terminal))
    throw new Error("Choose Ghostty or tmux for local launching.");
  const resume = resumeId !== undefined;
  const split = terminal === "split" ? splitOrigin() : undefined;
  if (terminal === "split" && (!split || resume || task !== ""))
    throw new Error(
      "Open in split requires the current local tmux pane and a blank agent. Use Copy context instead.",
    );
  if (resume) {
    if (
      terminal !== "tmux" ||
      agent === "pi" ||
      !isResumeId(resumeId) ||
      task !== ""
    )
      throw new Error(
        "Resume requires Claude or Codex, tmux, a full session ID and no task.",
      );
    // tmux rejects another new-session with this exact name on the same server.
    name = resumeSessionName(agent, resumeId);
  }
  if (terminal === "tmux" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || ""))
    throw new Error(
      "Job name: lowercase a-z, 0-9 and hyphens, at most 64 characters.",
    );
  if (!isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd))
    throw new Error("Choose an absolute local project directory.");
  const project = await stat(cwd).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw new Error("The local project directory no longer exists.");
    throw error;
  });
  if (!project.isDirectory())
    throw new Error("The local project must be a directory.");
  if (
    typeof task !== "string" ||
    Buffer.byteLength(task) > 256 * 1024 ||
    task.includes("\0")
  )
    throw new Error("Task must be text without NUL, at most 256 KiB.");
  signal?.throwIfAborted();
  const executable = await findExecutable(agent, signal);
  const tmux =
    terminal !== "ghostty" ? await findExecutable("tmux", signal) : undefined;

  // Task text and resume IDs are data, never AppleScript or shell source. The
  // terminal runner consumes this private handoff before starting the agent.
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-launch-"));
  const file = join(directory, "request.json");
  let submitted = false;
  try {
    await writeFile(
      file,
      JSON.stringify({
        executable,
        cwd,
        task,
        path: process.env.PATH,
        ...(split && { profile: agentProfile(agent) }),
        ...(resume && {
          resume: {
            agent,
            id: resumeId.toLowerCase(),
            profile: agentProfile(agent),
          },
        }),
      }),
      { mode: 0o600 },
    );
    signal?.throwIfAborted();
    const runner = [process.execPath, fileURLToPath(import.meta.url), file];
    if (split && tmux) {
      const { socket, pane, pid, session } = split;
      const format =
        "#{pid} #{session_id} #{pane_id} #{window_linked} #{window_active} #{pane_active} #{session_attached} #{pane_dead}";
      const expected = `${pid} ${session} ${pane} 0 1 1 1 0`;
      const { stdout } = await runProcess(
        tmux,
        [
          "-S",
          socket,
          "display-message",
          "-p",
          "-t",
          pane,
          `${format}\t#{pane_tty}`,
        ],
        { signal },
      );
      const [actual, tty] = stdout.trim().split("\t");
      const device =
        tty && /^\/dev\/[\w/.-]+$/.test(tty) ? await stat(tty) : undefined;
      if (
        actual !== expected ||
        !device?.isCharacterDevice() ||
        device.rdev !== fstatSync(process.stdin.fd).rdev ||
        device.rdev !== fstatSync(process.stdout.fd).rdev
      )
        throw new Error(
          "Cannot verify the current active tmux pane. Use Copy context instead.",
        );
      // Recheck the source and focus in tmux's own queue. The split has no -d:
      // focus moves to the new right pane, without leaving this window.
      const guard = `#{==:${format} #{pane_tty},${expected} ${tty}}`;
      const command = [
        "split-window",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        pane,
        "-c",
        cwd,
        ...runner,
      ]
        .map(quote)
        .join(" ");
      signal?.throwIfAborted();
      submitted = true;
      const result = await runProcess(
        tmux,
        [
          "-S",
          socket,
          "if-shell",
          "-F",
          "-t",
          pane,
          guard,
          command,
          "display-message -p not-current",
        ],
        { signal },
      );
      const opened = result.stdout.trim();
      if (opened === "not-current") {
        submitted = false;
        throw new Error("The active tmux pane changed. Open from Comms again.");
      }
      if (!/^%\d+$/.test(opened))
        throw new Error("tmux did not confirm the split.");
      return {
        message: "Opened a split in the current tmux window.",
        tmux: { socket, session, pane: opened },
      };
    }
    submitted = true;
    if (tmux) {
      // Multiple command arguments bypass tmux's shell parsing. The command
      // queue sets pane retention before processing any child-exit events.
      const { stdout } = await runProcess(
        tmux,
        [
          "new-session",
          "-d",
          "-s",
          name,
          "-c",
          cwd,
          "-P",
          "-F",
          resume
            ? "#{socket_path}\t#{session_id}\t#{pane_id}"
            : "#{socket_path}\t#{session_id}",
          ...runner,
          ";",
          "set-option",
          "-w",
          "-t",
          `=${name}:`,
          "remain-on-exit",
          "failed",
          ";",
          "set-option",
          "-w",
          "-t",
          `=${name}:`,
          "@pi-agents-agent",
          agent,
          ...(resume
            ? [
                ";",
                "set-option",
                "-p",
                "-F",
                "-t",
                `=${name}:`,
                "@pi-agents-resume",
                `${name}:#{pane_pid}`,
              ]
            : []),
        ],
        { signal },
      );
      const match = stdout
        .trim()
        .match(
          /^([^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+)\t(\$\d+)(?:\t(%\d+))?$/,
        );
      if (!match || !isAbsolute(match[1]) || Boolean(match[3]) !== resume)
        throw new Error("tmux did not return the expected target identity.");
      const [, socket, target, pane] = match;
      return {
        message: `${resume ? "Resume" : "Launch"} accepted in local tmux session ${name}. Agent status is not yet confirmed.`,
        attachCommand: `${quote(tmux)} -S ${quote(socket)} attach-session -t ${quote(target)}`,
        tmux: { socket, session: target, ...(pane && { pane }) },
      };
    }
    // AppleScript's surface command already receives Ghostty's exec wrapper.
    // Config-only prefixes such as shell: would become literal executable names.
    const result = await runProcess(
      "osascript",
      ["-e", GHOSTTY_SCRIPT, cwd, runner.map(quote).join(" ")],
      { signal, timeout: 30_000 },
    );
    return {
      message: `Launch accepted in Ghostty. Agent status is not yet confirmed. Window ${result.stdout.trim() || "created"}.`,
    };
  } catch (error) {
    if (!submitted) await rm(directory, { recursive: true, force: true });
    // A lost launcher reply may still have started the runner. Keep its
    // handoff readable rather than breaking a process that is about to start.
    const warning = split
      ? "A split may have opened. Check the current tmux window before retrying."
      : tmux
        ? `A tmux session may have started. Check tmux list-sessions before retrying. Attach if present: ${quote(tmux)} attach-session -t ${quote(`=${name}`)}`
        : "A window may have opened. Check Ghostty before retrying.";
    throw new Error(
      `${error.message}${submitted ? `\n${warning}\nUnconsumed handoff: ${file}` : ""}`,
    );
  }
}

async function findExecutable(name, signal) {
  const { stdout } = await runProcess("which", [name], { signal });
  const executable = stdout.trim();
  if (!isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable))
    throw new Error(`${name} is not available on the local PATH.`);
  return executable;
}

async function runAgent(file) {
  const request = JSON.parse(await readFile(file, "utf8"));
  await rm(file);
  // Only remove the now-empty, private handoff directory, never its contents.
  await rmdir(dirname(file));
  const env = { ...process.env, PATH: request.path || process.env.PATH };
  for (const key of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_MODEL",
    "PI_PROVIDER",
    "PI_REASONING_LEVEL",
    "PI_CODING_AGENT",
    "CLAUDECODE",
    "CODEX_THREAD_ID",
  ])
    delete env[key];
  let args;
  if (request.resume) {
    const { agent, id, profile } = request.resume;
    const key = profileKeys[agent];
    if (
      !["claude", "codex"].includes(agent) ||
      !isResumeId(id) ||
      profile.key !== key
    )
      throw new Error("Invalid resume handoff.");
    // A long-lived tmux server may have an older or different profile in its environment.
    if (profile.path === null) delete env[key];
    else env[key] = profile.path;
    args = agent === "claude" ? ["--resume", id] : ["resume", id];
  } else {
    if (request.profile) {
      const { key, path } = request.profile;
      if (!Object.values(profileKeys).includes(key))
        throw new Error("Invalid agent profile.");
      if (path === null) delete env[key];
      else env[key] = path;
    }
    // A prefix also prevents Pi from treating a leading @path as an attachment.
    args = request.task.trim()
      ? ["--", `Do the following task:\n\n${request.task}`]
      : [];
  }
  const child = spawn(request.executable, args, {
    cwd: request.cwd,
    env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => "")) ===
    fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("This runner requires a private launch handoff.");
    await runAgent(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
