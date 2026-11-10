# Configuration

Only `~/.config/pi-extensions/config.json` is discovered automatically. Keep it private. `PI_EXTENSIONS_CONFIG` selects an explicit file. Local paths support `~` and resolve relative to the selected configuration file, never a project's current directory.

## Identity and communication review

```json
{
  "identity": { "name": "Example User", "timeZone": "Europe/Paris" },
  "comms": {
    "notesDirectory": "~/notes",
    "reminderList": "Actions"
  }
}
```

Identity names are hints. Collectors must verify the connected account before assigning ownership. Calendar windows and tomorrow's snooze use the configured timezone. The default is UTC, not a guess about your location.

Comms includes neutral triage and message instructions. Override them with `comms.triageInstructions` and `messageInstructions`, each pointing to a private Markdown file. A configured notes checkout can also supply legacy `.claude/commands/triage.md` and `.claude/commands/message.md`. Explicit instruction paths take precedence.

`notesDirectory` sets the Claude collector's working directory and the legacy instruction lookup. It is not required for demo or ordinary collection. `PI_COMMS_NOTES_DIR` remains an explicit compatibility override. Missing required, explicitly configured instructions are reported.

`comms.voiceInstructions` points to an optional private file of writing rules for proposed replies, at most 8 KiB. Keep it to voice and formatting. Both collectors receive it inlined. An unreadable or oversized file is reported and drafts use the default voice.

`meetingInstructions`, `remarkableSource` and `notebookName` are still accepted so older configuration files load. Comms no longer collects meetings or captures reMarkable notebooks.

Opening `/comms` or selecting a collection/drafting action activates the corresponding queue access. `/comms demo` uses disposable data and does not authorize access to the real queue. Activated snapshot access can place retained private material into model context until the session is replaced or reloaded. See the Comms privacy section before enabling it.

## Remote host

```json
{
  "remote": {
    "host": "example-dev",
    "project": "~/projects/example",
    "sharedDirectory": "shared-dev"
  }
}
```

Configure authentication and ports in SSH's own configuration. `host` accepts an SSH alias or `user@host`, not shell options. There is one configured remote host. Existing `dev01` command names and stored target identifiers remain for compatibility.

`project` is a directory on that host. `sharedDirectory` is relative to each host's home unless absolute. File transfer and task launch happen only after an explicit command. Opening Agents permits read-only remote discovery only when a host is configured and discovery is enabled.

Remote targets retain their actual SSH destination alongside the legacy target marker. Attachment refuses a target from a different configured host. Once started, a remote operation keeps its destination through asynchronous probes, handoff or clipboard extraction. Configuration edits do not silently retarget an in-flight operation.

`PI_AGENTS_EXTERNAL=0` disables all external discovery. `PI_AGENTS_DEV01=0` disables the remote adapter. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` retain their native meanings. Unsupported sources report unavailable without hiding healthy sources.

## Speed tiers

```json
{ "fast": { "defaultTier": "priority" } }
```

The public default is `off`. `priority` deliberately increases usage or charges. Ultrafast is never an allowed configuration default. Request it explicitly with `/fast ultra` after reviewing the warning. Saved session-branch choices take precedence over the default, including older saved Ultra choices.

## Additional protected CLIs

```json
{
  "approval": {
    "protectedCommands": ["example-admin"],
    "readCommands": ["preview"]
  }
}
```

Configured executable names receive conservative mutation checks and prompts for unknown operations. `readCommands` adds reviewed operation names for those executables only. Recognized mutation verbs still take precedence. Neither setting is a general execution allowlist. Generic Git, destructive-command and MCP guards remain active without this setting.

Do not assume these rules cover every company CLI. Test your actual command grammar and credentials separately. The public package contains no company-specific production connection.

## Workstation integrations

```json
{
  "workstation": {
    "memory": true,
    "styleFile": "~/private/style.md",
    "skillPaths": ["~/shared-skills"],
    "promptPaths": ["~/private/prompts"],
    "qmdHook": "~/private/qmd-refresh.sh",
    "usageLog": "~/private/logs/skill-usage.jsonl"
  }
}
```

Each integration is independent and off unless configured. Memory uses the nearest matching Claude project ancestor, not a sibling project. Set `memoryDirectory` to override the default `~/.claude/projects` root. Only the matching index is injected. Topic files remain on-demand reads. Styles and memory contents are refreshed before a new agent run.

Skill/resource paths are references, not copied skill bundles. Missing paths are omitted. QMD refresh runs only in the interactive TUI and only through the configured hook. The hook is trusted local executable code.

`SKILL_USAGE_LOG` remains an explicit alternative log path. Logs contain invocation names, session ID and working directory, never command arguments or memory contents. `PI_QMD_REFRESH=0` and `PI_NOTIFY=0` retain their opt-out behavior.

## Reload behavior

Factory settings, including Fast defaults, approval policy and workstation paths, refresh on `/reload`. Comms and remote helpers also validate configuration when invoked. An open Comms view pins its Reminders destination. Reopen the view to select a newly configured list. Cached rows from another list are hidden rather than relabeled. There are no configuration watchers or per-token configuration reads.

Malformed configuration never silently reverts to weaker approval policy. Repair the private file and reload. Do not work around a broken guard by disabling it.
