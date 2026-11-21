# Configuration

Only the user configuration is discovered automatically, normally `~/.config/pi-extensions/config.json`. `XDG_CONFIG_HOME` changes the default directory. Keep it private. `PI_EXTENSIONS_CONFIG` selects an explicit file. Local paths support `~` and resolve relative to the selected configuration file, never a project's current directory.

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

## Local voice

```json
{
  "voice": {
    "shortcut": "ctrl+space",
    "mode": "hold",
    "space": false,
    "device": ":default"
  }
}
```

These are the configuration defaults. Enabled state is a separate private preference, not a `voice.enabled` configuration key. Voice is initially off unless saved on. `/voice` toggles and saves it. `/voice on` saves true and warms the current window without opening the microphone. `/voice off` saves false and stops it. The recording shortcut or `/voice start` while off also saves true and warms only, without capture.

The preference lives in `voice-state.json` beside the selected private configuration file, normally `~/.config/pi-extensions/voice-state.json`. It follows `XDG_CONFIG_HOME` or the parent of `PI_EXTENSIONS_CONFIG`. If the selected configuration is named `voice-state.json`, state uses `voice-preferences.json` instead. A preference alias to configuration is rejected. Only the enabled boolean and schema-version metadata are saved, never audio, transcripts or session data. New files use `0600`, and newly created parent directories use `0700`. Installation writes no state preset. Missing state means off. Invalid or unreadable state reports an error and leaves Voice off.

New, resumed, forked and reloaded sessions, new windows and Pi restarts read the latest preference at `session_start`. Saved-on restores `standby` with no model worker or microphone. Already-open windows are not live-synced. Cleanup, errors and idle unload do not erase the saved choice. Headless, RPC, SSH and unsupported environments never start workers.

`shortcut` accepts `ctrl+space` or a lowercase `ctrl+alt+letter` binding. The legacy `voice.cancelShortcut` key is accepted but ignored. There is no dedicated discard shortcut or widget hint. macOS can reserve Ctrl+Space for switching input sources. Disable that system binding or choose a supported alternative if it is active. Activation checks Pi's resolved keybindings, not operating-system or other application shortcuts. Option+Space remains available to Handy. Escape is unchanged. Ctrl+C discards Voice, including queued capture, while preserving Pi's native editor-clear and double-press-exit behavior. `/voice cancel` discards only dictation without changing the draft.

`mode` accepts `hold` or `toggle`. Hold uses Kitty key-release reporting where available. Otherwise short presses toggle recording. From standby, a recording gesture cold-loads the model and queues capture only while still requested. Hold the key and wait for `● recording` before talking. The loading hint says to wait before speaking. Releasing before warm-ready cancels capture intent. In toggle mode, a second press cancels queued capture or finalizes an active recording. `/voice stop` also cancels queued capture or finalizes recording. Voice never auto-submits. Enter normally submits the existing draft and retires active dictation.

`space` is an opt-in 300 ms hold gesture requiring Kitty release reporting. Short taps type ordinary spaces. The bundled Vim editor permits it only for literal Space in INSERT, not NORMAL commands such as `f` followed by Space. Pi's stock editor is supported. Other custom editors need an explicit `acceptsLiteralSpace` boolean getter. `/voice space on` and `/voice space off` override the setting for the current session, without enabling capture. Reload or session replacement restores the configured value.

`device` accepts AVFoundation `:default` or a colon followed by an audio device number, such as `:0`. Voice does not enumerate devices automatically. The [Voice device diagnostic](../extensions/voice/README.md#configuration-and-microphone-device) is explicitly user-triggered and can request microphone permission. Grant permission to the terminal through macOS privacy settings. Never bypass those controls.

Voice requires macOS arm64, interactive Pi outside SSH, existing `ffmpeg` and `uv`, and cached Python 3.10, `mlx-audio==0.5.3` and `mlx-community/parakeet-tdt-0.6b-v3`. [Run the explicit one-time setup](../extensions/voice/README.md#one-time-setup) to download and cache dependencies and the model as needed. Runtime forces `--offline` and `HF_HUB_OFFLINE=1`, so `/voice` makes no model downloads or network requests.

Previews stay above the editor. Final text uses native bracketed paste at the current cursor and preserves bundled Vim mode. If the draft changes or a modal has focus, the final stays pending in RAM. At the main prompt, press the recording shortcut or run `/voice insert` to explicitly insert. Use `/voice cancel` to discard only speech, or Ctrl+C to discard with native editor clearing. `/voice status` reports the current state. Inserting or discarding a pending final never reloads an unloaded model.

After five idle minutes in ready or pending, the entire model worker unloads. Voice stays enabled in standby, or keeps its pending final in RAM without the model. Loading, recording and finalizing do not idle-unload. Each actively used window has its own process group, not a shared server.

Configuration changes require `/reload`, which stops the worker and discards pending speech before rereading the saved preference. `/voice off`, session replacement and exit also tear it down. After updating this implementation, fully restart Pi. Native JavaScript module caching means `/reload` alone is insufficient. Run `/voice on` once after the restart to save an enabled preference if needed. Each recording is capped at 60 seconds. Voice writes no audio files or transcript logs. Submitted text still follows normal Pi provider and history behavior. See [Voice](../extensions/voice/README.md) for commands, cleanup limits and explicit manual-test requirements.

## Polish

```json
{
  "polish": {
    "rulesFile": null,
    "shortcut": "ctrl+alt+p",
    "model": null
  }
}
```

`rulesFile` defaults to `~/.agents/skills/polish-text/rules.md`. A configured path supports `~` and resolves relative to the selected configuration file. `shortcut` accepts only a lowercase `ctrl+alt+letter` that differs from `voice.shortcut`. `model` is `null` for the session's model or `provider/model-id`. See [Polish](../extensions/polish/README.md) for behavior, failures and privacy.

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

Factory settings, including Fast defaults, approval policy and workstation paths, refresh on `/reload`. Comms and remote helpers also validate configuration when invoked. An open Comms view pins its Reminders destination. Reopen the view to select a newly configured list. There are no configuration watchers or per-token configuration reads.

Malformed configuration never silently reverts to weaker approval policy. Repair the private file and reload. Do not work around a broken guard by disabling it.
