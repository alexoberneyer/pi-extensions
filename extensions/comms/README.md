# Comms for Pi

A local review queue for mail, Teams, calendar and Notion ticket requests. Nothing polls on startup. Browsing saved items makes no model or connector calls.

![Comms review queue with request details, actions and source coverage, shown with demo data](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/comms-demo.gif)

## Standalone use

With Pi and this package's JavaScript dependencies already installed, start from the package root:

```sh
pi -e ./extensions/comms/index.ts
```

Then run `/comms demo`. Demo uses disposable, memory-only data. It cannot read the real queue, enable queue tools, call models, open live sources or write reminders. Copying a demo draft is an explicit clipboard action.

| Command             | Effect                                     |
| ------------------- | ------------------------------------------ |
| `/comms`            | Browse the saved queue                     |
| `/comms refresh`    | Start a bounded read-only Claude collector |
| `/comms refresh pi` | Collect in the current Pi conversation     |
| `/comms next`       | Read the configured Apple Reminders list   |
| `/comms status`     | Show coverage, failures and queue location |
| `/comms cancel`     | Stop this session's Claude collector       |
| `/comms help`       | Show command help                          |

Tab changes views. Enter opens an item and its actions. Ctrl+G shows coverage. Ctrl+L reloads local state. Ctrl+R starts collection, reads Reminders in the Next view, or resets demo fixtures. Escape closes the view. Ctrl+S explicitly saves an edited draft or adds a reviewed reminder.

## Reply-ready triage

Collection always suggests a concrete next action. It can also prepare a local reply for mail or Teams when the thread and recipient are verified and the answer needs no missing facts, user decision or invented commitment. Otherwise the item names the blocker. Proposals seed only new or untouched empty drafts. Refresh never replaces your saved wording or resurrects a deliberately cleared draft.

Open an item to read its proposed action and unsent draft. Edit locally with Ctrl+S, copy the draft and open the original to send it yourself. Comms never sends messages or creates remote drafts. The queue reopens after a normally completed AI-drafting job unless other input or work needs focus.

## Legacy items

Earlier releases also collected meeting follow-ups and reMarkable captures. Saved items from those sources still load and appear in the queue. They support Add to Reminders, Snooze, Waiting, Resolve and Dismiss, but no drafting. Comms no longer refreshes them.

## Configuration

Use the package's user configuration at `$XDG_CONFIG_HOME/pi-extensions/config.json`, defaulting to `~/.config/pi-extensions/config.json`. `PI_EXTENSIONS_CONFIG` selects another file. Malformed configuration is an error.

```json
{
  "identity": { "name": "the authenticated user", "timeZone": "UTC" },
  "comms": {
    "notesDirectory": null,
    "triageInstructions": null,
    "messageInstructions": null,
    "reminderList": "Next"
  }
}
```

Neutral triage and message templates ship in `workflows/comms/`. No private notes checkout is required for demo or normal collection. Explicit instruction paths override bundled templates. For compatibility, a configured notes directory or `PI_COMMS_NOTES_DIR` can supply `.claude/commands/triage.md` and `.claude/commands/message.md`. Explicit instruction paths take precedence. The environment variable overrides the notes directory only. Missing legacy files use bundled templates. Missing required overrides fail visibly.

`meetingInstructions`, `remarkableSource` and `notebookName` are still accepted so older configuration files load. Comms no longer uses them. Accepted actions use the configured Reminders list. Calendar windows and tomorrow-at-09:00 snoozes use the configured timezone. Identity labels never replace authenticated-account verification.

## Prerequisites

1. **Default collection:** an existing, signed-in `claude` CLI with reviewed Microsoft 365 and Notion read connectors. Comms does not install connectors, log in, copy credentials or configure accounts. The exact external allowlist is in `triage-guard.mjs`. Unsupported connectors remain unavailable. Claude starts in the configured notes directory, or the package root when none is configured. Trusted Claude startup settings and hooks still apply.
2. **Pi-native collection:** existing read-only tools connected in Pi. Tool discovery uses the actual available names. Missing mail, chat, calendar or ticket access is reported independently, never treated as an empty source.
3. **Apple Reminders:** macOS, `uv` and this terminal's Automation permission for Reminders. The target list must already exist. Comms invokes package-relative `helpers/to_next.py` through `uv run`. No Python dependencies are needed for Reminders.

Local review and collection can run on other platforms. Reminders and source launching are Mac-only.

## Privacy and protections

Queue tools start inactive. Their execution guards reject calls before a user `/comms` action, even if a caller tries invoking them directly. Pi-native refresh and selected AI actions enable only their required tools. Mutations also require the current job token or selected-item revision. Demo grants no access to the real queue.

Comms initializes the bundled approval guard even when loaded alone. Collection and drafting block external writes, including nested calls. These are workflow guards, not an OS sandbox. Read-only connector annotations are hints. No automatic remote writes or automatic retries occur.

The Claude child receives minimal source evidence and retained requests, excluding local reply drafts and legacy items. It uses a non-persistent session, a read allowlist, a 100-turn cap, a 15-minute process limit and a 16 MiB output limit. Cancellation or fatal process errors import nothing. Valid source/account results merge independently. Failed or partial sources keep their checkpoint. Missing requests never imply completion. Evidence-backed resolution applies only to unchanged retained items. Concurrent edits and drafts are preserved.

Notion page fetches never include raw transcripts.

Private state stays at `<Pi agent directory>/comms/queue.json`, respecting `PI_CODING_AGENT_DIR`. Directories use `0700` and files `0600`. Existing paths and item keys are preserved. Atomic writes, revision checks, size limits and locks protect the queue. Corrupt state is reported without replacement. Inspect a lock's PID and remote outcome before removing a stale `write.lock` or `triage.lock`.

Pi-native collection and AI drafting send evidence to Pi's selected model and retain it in session history. Resolved history and legacy capture images under `comms/remarkable-pages/` are not automatically deleted.

## Offline checks

```sh
node scripts/test.mjs tests/comms*.test.mjs
prettier --check 'extensions/comms/**/*.{ts,mjs,md}' 'workflows/comms/*.md' 'tests/comms*.test.mjs'
```

Tests use temporary state, synthetic records and fake executables. No login, model call, real inbox or Reminders app is needed.
