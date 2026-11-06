# Agents dashboard

Run `/agents` for one view of Pi, Claude Code, Codex and tracked tmux sessions. Browsing does not call a model. External discovery runs only while the dashboard is open.

Install the package, then enable this entrypoint through `pi config`:

```sh
pi -e /absolute/path/to/pi-extensions/extensions/agents/index.ts
```

The package's `ws` dependency supports Codex's existing local socket transport. Pi status files remain under `<agent directory>/agents-status/`. Directories are private and files use `0600`. External session metadata stays in dashboard memory, not a new transcript archive.

## Controls

| Key           | Action                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| Type          | Search title, tool, project and preview                                         |
| Up/Down       | Select a row                                                                    |
| Tab/Shift+Tab | Cycle status filters                                                            |
| Ctrl+O        | Cycle tools                                                                     |
| Ctrl+P        | All projects or current local project                                           |
| Ctrl+R        | Refresh external sources and saved Pi history                                   |
| Enter         | Open a verified tmux target, return here, or confirm reopening saved Pi history |
| Ctrl+N        | Launch form on macOS                                                            |
| Ctrl+X        | Confirm closing the exact selected local tmux pane                              |
| Ctrl+Y        | Copy an attach/native command                                                   |
| Escape        | Clear search, then return to the conversation                                   |

Native command strings are only copied, never executed by selecting an external row. Attachment uses structured socket/session/pane identities. Closing a pane is abrupt and can interrupt running work. Saved history is not deleted.

## Discovery

- Pi uses its private presence registry and native session metadata. Other tracked live Pi processes cannot have their conversation resumed here, even if idle.
- Claude uses `claude agents --json` and respects `CLAUDE_CONFIG_DIR`.
- Codex reads loaded threads from the existing app-server socket under `$CODEX_HOME`, defaulting to `~/.codex`. It does not start a daemon or subscribe to turns.
- Local tmux discovery reads pane metadata and process ancestry, not pane output, arguments or environment.
- Remote discovery needs `remote.host` in the private configuration. It uses SSH and a bundled read-only Python probe. Remote paths/PIDs never become local resume targets.

External adapters poll every five seconds while browsing. One failed adapter does not hide another. Failed evidence becomes State unavailable and disables stale attach commands. Poll time is not substituted for last activity.

## Conversation descriptions

Claude and Codex keep meaningful native names. Hash-only names fall back to the first readable user prompt. Verified empty sessions say New session. Missing task metadata keeps an honest project label, not an invented task. Native conversation IDs stay in connection details.

Local adapters read existing native metadata for discovered sessions, respecting `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Each transcript read is bounded to its first and last 256 KiB, cached in dashboard memory until the file changes. Only user/assistant text is displayed, never reasoning or tool output. A pending question takes priority over recent conversation text. Missing or corrupt metadata does not change native status, activity time or attachment authority.

Tmux-only Claude and Codex panes use meaningful agent-set pane titles or custom session names. Generic application titles and generated job hashes are ignored. These labels never prove thread ownership. Pi descriptions and its ownership checks are unchanged. Remote discovery still uses the remote probe's native metadata, without reading remote transcripts on the Mac.

`PI_AGENTS_EXTERNAL=0` disables external discovery. `PI_AGENTS_DEV01=0` disables the configured remote adapter. No remote probe runs with the default null host.

## Launching and attachment

Local launches currently require macOS, tmux and an installed/authenticated agent. Launching uses that host's model and permission settings, not bypass flags. Remote launches require the configured SSH host and an existing project directory. The shared directory is not an isolated checkout.

A launch acknowledgment does not prove readiness or completion. Failed replies can have an uncertain outcome. Inspect existing tmux sessions before retrying. Launches are never automatically retried or redirected to another terminal.

Opening another tmux agent temporarily releases terminal ownership, not the parent Pi runtime. Detach to return. Pending input, model activity and the conversation stay in the original process. Targets are checked before handoff. The dashboard never executes an arbitrary displayed native command.

Titles and previews can contain private material. They are displayed locally and are not sent to a model by browsing this dashboard. Private presence records are runtime data, never package files.
