# dev01 commands

Run remote agent jobs from Pi or the terminal. `dev01` is the compatible command
and state label, not a fixed server name. The SSH destination is configurable.
The local `/agents` dashboard works without remote configuration.

## Install and configure

1. Install the package from a reviewed checkout: `pi install /path/to/pi-extensions`.
2. Create `~/.config/pi-extensions/config.json`, or set `PI_EXTENSIONS_CONFIG` to
   an explicit JSON file. `XDG_CONFIG_HOME` changes the default config directory.
3. Configure an existing SSH alias and directories, then run `/reload` in Pi:

```json
{
  "remote": {
    "host": "build-box",
    "project": "~/work/project",
    "sharedDirectory": "shared-dev"
  }
}
```

`remote.host` defaults to `null`. Without a host, remote commands fail with a
configuration message. Opening `/agents` does not poll a remote machine.
Loading either extension starts no discovery processes or network connections.
Malformed configuration fails closed. Configuration is never read from a project.

`remote.project` defaults to `~` and must already exist on the remote host.
`remote.sharedDirectory` defaults to `shared-dev`. Relative paths and `~/` paths
resolve against each host's own home. Absolute paths are used as supplied.
The shared directory setting applies to both transfer endpoints and remote
prompt and clipboard storage. Paths are literal data, not shell expressions.

The remote host needs Bash, tmux and the selected agent on its login PATH.
Read-only discovery also needs Python 3 and `ps`. Claude status requires a
version supporting `claude agents --json`. Transfers require rsync with
`--protect-args` support on both hosts. Clipboard upload requires macOS.

Install and authenticate agents separately on the remote host. This package
copies no credentials, model defaults, permissions or project trust decisions.
Review the remote project's trust settings interactively before detached work.
SSH uses your existing authentication and host-key verification. It never logs
in or accepts host keys for you.

## Use in Pi

```text
/devpush -n
/devpush
/devrun pr-summary Summarise the open PRs. Save the report in the shared directory.
/devrun --agent pi research Investigate the alternatives.
/devrun --agent codex fix-tests Fix the failing tests.
/devls
/devpull -n
/devpull
/devclip
```

| Command                                             | Behaviour                                          |
| --------------------------------------------------- | -------------------------------------------------- |
| `/devpush [-n]`                                     | Upload the configured shared directory             |
| `/devpull [-n]`                                     | Download the configured shared directory           |
| `/devrun [--agent pi\|claude\|codex] <name> <task>` | Start a detached job in `remote.project`           |
| `/devls`                                            | List remote tmux panes and guarded attach commands |
| `/devclip`                                          | Upload a clipboard PNG and copy its remote path    |

The default job agent is `claude`. Put `--agent` before the name. Everything
after the name is task text, including flags, quotes and newlines. Names use
lowercase letters, digits and hyphens, start with a letter or digit, and contain
at most 64 characters. Tasks are limited to 256 KiB.

Tasks travel through SSH stdin to `<sharedDirectory>/prompts/<name>.md`, never
as shell source. Prompt files are private. A per-name lock and existing-session
check prevent competing launches from overwriting a running job's prompt.
A lost SSH reply is ambiguous. Check `/devls` before retrying. Launches never
retry automatically.

Each agent uses its own remote model, reasoning and permission settings. No
approval bypass is added. Attach when an agent needs login, trust or approval.
A started process is not a completed task. No current conversation context is
sent unless included in the task or shared files.

Transfers preserve `rsync -avu --partial`: newer destination files are skipped,
and nothing is deleted. Only `-n` and `--dry-run` are accepted. The whole shared
directory is copied, including prompts and clips. This is file handoff, not
conflict resolution or Git synchronization. Launching does not transfer files.

Command output enters Pi's transcript without starting a model turn. Clipboard
access happens only on `/devclip`, which replaces the clipboard with the
uploaded image's remote path.

## Use in a terminal

The package ships `bin/dev01.mjs`. It does not install shell functions or modify
your shell startup files. Invoke the helper from the package checkout:

```sh
node /path/to/pi-extensions/bin/dev01.mjs push -n
node /path/to/pi-extensions/bin/dev01.mjs run --agent pi research 'Investigate alternatives.'
node /path/to/pi-extensions/bin/dev01.mjs ls
node /path/to/pi-extensions/bin/dev01.mjs status --json
```

The helper accepts `push`, `pull`, `run`, `clip`, `ls` and `status --json`.
Pi imports the same implementation. Neither loads interactive shell setup.

## Agents dashboard

On macOS, `/agents` polls the configured host only while open. Search for
`dev01` to show remote rows. Tool filters work across hosts. The current-project
filter remains local-only. Remote checkouts are never treated as local paths.

Press **Ctrl+N** to launch an interactive agent. Choose dev01, select Pi,
Claude or Codex, and edit the remote project if needed. Its initial value is
`remote.project`. Tab/Up/Down moves between fields. Left/Right changes Host or
Agent. Enter launches and opens the session. Escape cancels. Describe the task
inside the new session. This flow uploads no task file or conversation context.
`/devrun` retains its separate name-and-task workflow.

- Claude status comes from `claude agents --json`.
- Pi status comes from remote `agents-status` records. PIDs and heartbeat
  freshness are checked on the owning host. Install this package and run
  `/reload` in a remote Pi session to publish its status.
- Untracked tmux panes stay **Unknown**. A pane is not proof of working or
  completed work. Remote Codex has tmux visibility only.
- Enter opens only a structured, verified tmux target. It never executes the
  displayed command string. Outside local tmux, SSH uses the current terminal.
  Inside local tmux, it opens a sibling window. Detach or switch back to return.
- Failed opening can reconnect to the same target without launching again.
  Ctrl+Y copies a guarded attach command. Non-tmux rows remain guidance-only.
- Stale or duplicate Pi owners lose attachment. Headless children cannot claim
  their parent's terminal. Remote sessions never enter local resume paths.
- Native sources are probed independently. Source failures keep last-seen rows
  **Unknown**, with stale attachment disabled. SSH failure affects only remote
  rows. Closing the dashboard cancels helpers, not remote agents.

Set `PI_AGENTS_DEV01=0` to disable dashboard remote discovery and launching.
`PI_AGENTS_EXTERNAL=0` disables all external discovery and remote launching.
Explicit `/devrun` commands remain available when a host is configured.

`bin/dev01-status.py` is shipped with the package and sent through SSH stdin.
It writes no remote probe file. Noninteractive calls use batch mode and bounded
timeouts, never password prompts. `/devls` reports discovery failure rather than
falsely claiming an empty session list.

Shutdown and reload abort pending local helpers. They cannot promise to undo a
transfer or launch already accepted remotely. There is no remote kill command,
automatic approval or conversation takeover.

## Verify

From the package root:

```sh
TMPDIR=/tmp node scripts/test.mjs tests/agents.test.mjs tests/agents-attach.test.mjs tests/agents-close.test.mjs tests/agents-external.test.mjs tests/agents-launch.test.mjs tests/agents-remote.test.mjs tests/dev01.test.mjs
prettier --check extensions/agents extensions/dev01 bin tests/agents*.test.mjs tests/dev01.test.mjs
```

Tests isolate HOME and configuration, fake SSH, rsync and clipboard executables,
and use private tmux sockets. A short temporary path avoids macOS Unix socket
length limits. No remote jobs or model calls are made.
