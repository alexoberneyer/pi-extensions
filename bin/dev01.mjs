#!/usr/bin/env node
// Shared by the terminal commands and Pi. No interactive shell setup is loaded.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig, expandPath, packagePath } from "../lib/config.mjs";

export function remoteConfig() {
  const config = readConfig().remote;
  if (!config.host)
    throw new Error(
      "Remote access is disabled. Set remote.host in the Pi extensions configuration.",
    );
  return config;
}

// Paths are data. Expand only the owning host's HOME, never shell expressions.
function remotePath(variable, value) {
  return `${variable}=${quote(value)}
case "$${variable}" in
  '~') ${variable}=$HOME ;;
  '~/'*) ${variable}="$HOME/\${${variable}:2}" ;;
  /*) ;;
  *) ${variable}="$HOME/$${variable}" ;;
esac`;
}
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
];

export function quote(value) {
  if (value.includes("\0")) throw new Error("NUL is not a shell argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cleanOutput(value) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function runProcess(
  file,
  args,
  { input, signal, timeout = 15_000 } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        signal,
        timeout,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Node's AbortSignal path uses SIGTERM, regardless of killSignal.
        if (signal?.aborted) child.kill("SIGKILL");
        if (error) {
          reject(
            new Error(
              signal?.aborted
                ? "Operation cancelled"
                : `${file} failed: ${cleanOutput(stderr || error.message).slice(0, 2000)}`,
            ),
          );
        } else resolve({ stdout, stderr });
      },
    );
    child.stdin.on("error", () => {}); // An early remote exit can close stdin.
    child.stdin.end(input);
  });
}

function isSshHost(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(value) &&
    !/\s/.test(value)
  );
}

export function remote(
  script,
  { sshHost = remoteConfig().host, ...options } = {},
) {
  if (!isSshHost(sshHost)) throw new Error("Invalid remote SSH destination");
  return runProcess(
    "ssh",
    [...SSH_OPTIONS, sshHost, `bash -lc ${quote(script)}`],
    options,
  );
}

function isRemoteTarget(target) {
  return (
    target?.host === "dev01" &&
    isSshHost(target.sshHost) &&
    typeof target.socket === "string" &&
    isAbsolute(target.socket) &&
    target.socket.length <= 4_096 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(
      target.socket,
    ) &&
    typeof target.session === "string" &&
    /^\$\d+$/.test(target.session) &&
    !/\s/.test(target.session) &&
    (target.pane === undefined ||
      (typeof target.pane === "string" &&
        /^%\d+$/.test(target.pane) &&
        !/\s/.test(target.pane)))
  );
}

function parseRemoteTmux(stdout, sshHost) {
  // Parse only the atomic new-session reply, never a command or session name.
  const match = stdout.match(/^([^\t\r\n]+)\t(\$\d+)\t(%\d+)\n?$/);
  const target = match && {
    host: "dev01",
    sshHost,
    socket: match[1],
    session: match[2],
    pane: match[3],
  };
  if (!match || match[0] !== stdout || !isRemoteTarget(target))
    throw new Error(
      "tmux did not return a valid socket path, session ID and pane ID.",
    );
  return target;
}

// A single tmux command queue checks ownership, selects the pane, then attaches.
// No shell runs inside tmux. A disappeared or moved pane cannot open a different agent.
export function remoteTmuxAttachArgs(target) {
  if (!isRemoteTarget(target) || typeof target.pane !== "string")
    throw new Error("Invalid remote tmux target");
  return [
    "-S",
    target.socket,
    "if-shell",
    "-F",
    "-t",
    target.pane,
    `#{==:#{session_id},${target.session}}`,
    `select-window -t ${target.pane} ; select-pane -t ${target.pane} ; attach-session -t '${target.session}'`,
    'display-message -p "That remote tmux agent moved or exited. Refresh /agents."',
  ];
}

export function attachCommand(target) {
  if (typeof target !== "string") {
    const args = remoteTmuxAttachArgs(target);
    return `ssh -t ${target.sshHost} ${quote(`tmux ${args.map(quote).join(" ")}`)}`;
  }
  const { host } = remoteConfig();
  if (!/^(?:\$\d+|[a-z0-9][a-z0-9-]{0,63})$/.test(target))
    throw new Error("Invalid tmux target");
  // tmux is on dev01's SSH PATH. Escape its numeric session ID for the remote
  // shell without nesting another login shell or requiring the local dev function.
  const remoteTarget = target.startsWith("$") ? `\\${target}` : target;
  return `ssh -t ${host} ${quote(`tmux attach-session -t ${remoteTarget}`)}`;
}

export async function snapshot(signal) {
  const { host: sshHost } = remoteConfig();
  const script = await readFile(packagePath("bin", "dev01-status.py"), "utf8");
  const { stdout } = await remote("python3 -", {
    sshHost,
    input: script,
    signal,
    timeout: 10_000,
  });
  const value = JSON.parse(stdout);
  if (
    value?.version !== 1 ||
    !Array.isArray(value.panes) ||
    !Array.isArray(value.claude) ||
    !Array.isArray(value.pi) ||
    !Number.isFinite(value.now)
  )
    throw new Error("Unsupported dev01 status response");
  // The destination is local transport evidence, never a remote-reported field.
  return { ...value, sshHost };
}

export async function transfer(direction, args = [], signal) {
  if (!["push", "pull"].includes(direction))
    throw new Error("Invalid transfer direction");
  if (args.some((arg) => !["-n", "--dry-run"].includes(arg)))
    throw new Error(
      "Only -n / --dry-run is supported. Transfers never delete files.",
    );
  const { host, sharedDirectory } = remoteConfig();
  const local = `${expandPath(sharedDirectory)}/`;
  // Protected rsync arguments bypass remote shell parsing. Home-relative paths
  // remain relative on the remote host, not on this machine.
  const directory =
    sharedDirectory === "~" ? "." : sharedDirectory.replace(/^~\//, "");
  const server = `${host}:${directory}/`;
  const paths = direction === "push" ? [local, server] : [server, local];
  const result = await runProcess(
    "rsync",
    [
      "-avu",
      "--partial",
      "--protect-args",
      "-e",
      ["ssh", ...SSH_OPTIONS].join(" "),
      ...args,
      ...paths,
    ],
    { signal, timeout: 10 * 60_000 },
  );
  return (
    cleanOutput(result.stdout + result.stderr).trim() || "Nothing to transfer."
  );
}

const RUN_USAGE =
  "Usage: devrun [--agent pi|claude|codex] <name: a-z0-9, then a-z0-9-, max 64> <task>";

// CLI argv is already shell-parsed. Pi supplies raw text. Read only the header;
// everything after the name is task data, including quotes, flags and newlines.
export function runJob(input, signal) {
  let remaining = input;
  const take = () => {
    if (Array.isArray(remaining)) {
      const [word, ...rest] = remaining;
      remaining = rest;
      return word;
    }
    const match = remaining.match(/^\s*(\S+)(?:\s+|$)/);
    remaining = match ? remaining.slice(match[0].length) : "";
    return match?.[1];
  };
  let name = take();
  let agent = "claude";
  if (name === "--agent") {
    agent = take();
    name = take();
    if (!agent) throw new Error(RUN_USAGE);
  }
  const prompt = Array.isArray(remaining) ? remaining.join(" ") : remaining;
  return startJob(name, prompt, { agent, signal });
}

export async function startJob(name, prompt, options) {
  return (await startJobWithTarget(name, prompt, options)).message;
}

export async function startJobWithTarget(
  name,
  prompt,
  { agent = "claude", signal } = {},
) {
  if (!["pi", "claude", "codex"].includes(agent))
    throw new Error("Unknown agent. Use pi, claude or codex.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || "") || !prompt?.trim())
    throw new Error(RUN_USAGE);
  if (Buffer.byteLength(prompt) > 256 * 1024)
    throw new Error("Task exceeds 256 KiB");
  const label = { pi: "Pi", claude: "Claude", codex: "Codex" }[agent];
  const { host: sshHost, project, sharedDirectory } = remoteConfig();
  // Resolve the executable in the login shell, not tmux's possibly stale PATH.
  // Configured paths are quoted data, just like the validated job name.
  const script = `set -eu
umask 077
name=${quote(name)}
agent=$(command -v ${agent}) || { echo "${agent} is not installed on dev01" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is not installed on dev01" >&2; exit 1; }
${remotePath("cwd", project)}
${remotePath("shared", sharedDirectory)}
cd -- "$cwd"
mkdir -p -- "$shared/prompts"
lock="$shared/prompts/.$name.lock"
mkdir "$lock" 2>/dev/null || { echo "Another launch holds $lock" >&2; exit 1; }
tmp=
trap 'rm -f -- "$tmp"; rmdir -- "$lock"' EXIT
if tmux has-session -t "=$name" 2>/dev/null; then
  echo "Session $name already exists. Attach to it instead." >&2
  exit 1
fi
tmp=$(mktemp "$shared/prompts/.$name.XXXXXX")
cat > "$tmp"
[ "$(wc -c < "$tmp")" -eq ${Buffer.byteLength(prompt)} ] || { echo "Incomplete task upload" >&2; exit 1; }
f="$shared/prompts/$name.md"
mv -- "$tmp" "$f"
cwd=\${cwd//#/##}
tmux new-session -d -s "$name" -c "$cwd/" -P -F '#{socket_path}\t#{session_id}\t#{pane_id}' "$agent" "Do the task in $f"`;
  try {
    const { stdout } = await remote(script, { sshHost, input: prompt, signal });
    const remoteTmux = parseRemoteTmux(stdout, sshHost);
    const command = attachCommand(remoteTmux);
    return {
      message: `Started ${label} job ${name} on dev01. This is not a completion report.\nAttach: ${command}`,
      attachCommand: command,
      remoteTmux,
    };
  } catch (error) {
    throw new Error(
      `${error.message}\nLaunch may have reached dev01. Check devls before retrying.`,
    );
  }
}

export async function startInteractiveWithTarget(
  name,
  { agent = "pi", cwd, signal } = {},
) {
  if (!["pi", "claude", "codex"].includes(agent))
    throw new Error("Unknown agent. Use pi, claude or codex.");
  if (
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
    /\s/.test(name)
  )
    throw new Error(
      "Session name: lowercase a-z, 0-9 and hyphens, at most 64 characters.",
    );
  const { host: sshHost, project } = remoteConfig();
  if (cwd === undefined) cwd = project;
  if (
    typeof cwd !== "string" ||
    !cwd.trim() ||
    /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(cwd)
  )
    throw new Error("Choose a remote project path without control characters.");
  const label = { pi: "Pi", claude: "Claude", codex: "Codex" }[agent];
  const script = `set -eu
umask 077
name=${quote(name)}
${remotePath("cwd", cwd)}
[ -d "$cwd" ] || { echo "Remote project is not a directory: $cwd" >&2; exit 1; }
cd -- "$cwd"
agent=$(command -v ${agent}) || { echo "${agent} is not installed on dev01" >&2; exit 1; }
[[ "$agent" = /* && -f "$agent" && -x "$agent" ]] || { echo "${agent} is not an executable on dev01's login PATH" >&2; exit 1; }
tmux=$(command -v tmux) || { echo "tmux is not installed on dev01" >&2; exit 1; }
[[ "$tmux" = /* && -f "$tmux" && -x "$tmux" ]] || { echo "tmux is not an executable on dev01's login PATH" >&2; exit 1; }
if "$tmux" has-session -t "=$name" 2>/dev/null; then
  echo "Session $name already exists. Attach to it instead." >&2
  exit 1
fi
# Escape tmux formats in the directory. A trailing slash avoids its ; separator.
cwd=\${cwd//#/##}
# tmux's command parser also treats an argv value ending in ; as a separator.
login_path=$PATH
case "$login_path" in *';') login_path="\${login_path%;}\\\\;" ;; esac
# Multiple command arguments bypass shell parsing. Set retention before exits run.
"$tmux" new-session -d -s "$name" -c "$cwd/" -P -F '#{socket_path}\t#{session_id}\t#{pane_id}' /usr/bin/env -u PI_SESSION_ID -u PI_SESSION_FILE -u PI_MODEL -u PI_PROVIDER -u PI_REASONING_LEVEL -u PI_CODING_AGENT -u CLAUDECODE -u CODEX_THREAD_ID "PATH=$login_path" "$agent" ';' set-option -w -t "=$name:" remain-on-exit failed ';' set-option -w -t "=$name:" @pi-agents-agent ${agent}`;
  try {
    const { stdout } = await remote(script, { sshHost, signal });
    const remoteTmux = parseRemoteTmux(stdout, sshHost);
    const command = attachCommand(remoteTmux);
    return {
      message: `Started ${label} session ${name} on dev01. Agent readiness is not confirmed.\nAttach: ${command}`,
      attachCommand: command,
      remoteTmux,
    };
  } catch (error) {
    throw new Error(
      `${error.message}\nLaunch may have reached dev01. Check devls before retrying.`,
    );
  }
}

export async function uploadClipboard(signal) {
  const { host: sshHost, sharedDirectory } = remoteConfig();
  if (process.platform !== "darwin")
    throw new Error("devclip needs the Mac clipboard");
  const directory = await mkdtemp(join(tmpdir(), "devclip-"));
  try {
    const file = join(directory, "image.png");
    await runProcess(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "set imageData to the clipboard as «class PNGf»",
        "-e",
        "set f to open for access POSIX file (item 1 of argv) with write permission",
        "-e",
        "try",
        "-e",
        "write imageData to f",
        "-e",
        "on error messageText number messageNumber",
        "-e",
        "close access f",
        "-e",
        "error messageText number messageNumber",
        "-e",
        "end try",
        "-e",
        "close access f",
        "-e",
        "end run",
        file,
      ],
      { signal },
    );
    const image = await readFile(file);
    if (
      !image
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("No PNG image on the clipboard");
    const name = `clip-${randomUUID()}.png`;
    const { stdout } = await remote(
      `set -eu
umask 077
${remotePath("shared", sharedDirectory)}
mkdir -p -- "$shared/clips"
f="$shared/clips/${name}"
trap 'rm -f -- "$f"' EXIT
cat > "$f"
[ "$(wc -c < "$f")" -eq ${image.length} ] || { echo "Incomplete image upload" >&2; exit 1; }
trap - EXIT
printf '%s\\n' "$f"`,
      { sshHost, input: image, signal, timeout: 30_000 },
    );
    const path = stdout.trim();
    if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path))
      throw new Error("Upload succeeded, but dev01 returned an invalid path");
    try {
      await runProcess("pbcopy", [], { input: path, signal });
      return `Path copied: ${path}`;
    } catch {
      return `Uploaded: ${path}\nClipboard copy failed. Copy the path above.`;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function listPanes(signal) {
  const value = await snapshot(signal);
  if (value.errors?.includes("tmux"))
    throw new Error(
      "dev01 tmux discovery unavailable. This is not an empty session list.",
    );
  if (!value.panes.length) return "No tmux sessions on dev01.";
  return value.panes
    .map(
      (pane) =>
        `${cleanOutput(pane.name)} · ${cleanOutput(pane.command)} · ${pane.id}\n  ${attachCommand({ host: "dev01", sshHost: value.sshHost, socket: pane.socket, session: pane.sessionId, pane: pane.id })}`,
    )
    .join("\n");
}

async function main(args) {
  const [action, ...rest] = args;
  switch (action) {
    case "push":
    case "pull":
      return transfer(action, rest);
    case "run":
      return runJob(rest);
    case "clip":
      if (rest.length) throw new Error("Usage: dev01 clip");
      return uploadClipboard();
    case "ls":
      if (rest.length) throw new Error("Usage: dev01 ls");
      return listPanes();
    case "status":
      if (rest.length !== 1 || rest[0] !== "--json")
        throw new Error("Usage: dev01 status --json");
      return JSON.stringify(await snapshot());
    default:
      throw new Error(
        "Usage: dev01 push|pull [-n] | run [--agent pi|claude|codex] <name> <task> | clip | ls | status --json",
      );
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => "")) ===
    fileURLToPath(import.meta.url)
) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(cleanOutput(error.message));
    process.exitCode = 1;
  }
}
