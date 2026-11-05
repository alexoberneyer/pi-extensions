// Local launcher and terminal runner. Importing performs no I/O.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

export async function launchLocal(
  { agent, cwd, task, terminal = "ghostty", name },
  signal,
) {
  if (process.platform !== "darwin")
    throw new Error("Local launching requires macOS.");
  if (!["pi", "claude", "codex"].includes(agent))
    throw new Error("Unknown agent. Use pi, claude or codex.");
  if (!["ghostty", "tmux"].includes(terminal))
    throw new Error("Choose Ghostty or tmux for local launching.");
  if (terminal === "tmux" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || ""))
    throw new Error(
      "Job name: lowercase a-z, 0-9 and hyphens, at most 64 characters.",
    );
  if (!isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd))
    throw new Error("Choose an absolute local project directory.");
  if (!(await stat(cwd)).isDirectory())
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
    terminal === "tmux" ? await findExecutable("tmux", signal) : undefined;

  // Task text is data, never AppleScript or shell source. The terminal runner
  // consumes and deletes this private handoff before starting the agent.
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-launch-"));
  const file = join(directory, "request.json");
  let submitted = false;
  try {
    await writeFile(
      file,
      JSON.stringify({ executable, cwd, task, path: process.env.PATH }),
      { mode: 0o600 },
    );
    signal?.throwIfAborted();
    const runner = [process.execPath, fileURLToPath(import.meta.url), file];
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
          "#{socket_path}\t#{session_id}",
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
        ],
        { signal },
      );
      const match = stdout
        .trim()
        .match(/^([^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+)\t(\$\d+)$/);
      if (!match || !isAbsolute(match[1]))
        throw new Error("tmux did not return a socket path and session ID.");
      const [, socket, target] = match;
      return {
        message: `Launch accepted in local tmux session ${name}. Agent status is not yet confirmed.`,
        attachCommand: `${quote(tmux)} -S ${quote(socket)} attach-session -t ${quote(target)}`,
        tmux: { socket, session: target },
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
    const warning = tmux
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
  // A prefix also prevents Pi from treating a leading @path as an attachment.
  const args = request.task.trim()
    ? ["--", `Do the following task:\n\n${request.task}`]
    : [];
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
