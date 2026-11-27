# Comms for Pi

A local review queue for mail, Teams, calendar and Notion ticket requests. Nothing polls on startup. Browsing saved items makes no model or connector calls.

![Comms opening a synthetic request in a mock agent split, with context pasted manually and left unsent](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/comms-handoff-demo.gif)

Open a request → choose an agent → manually paste the context into the focused split. The recording uses synthetic data, a private clipboard fixture and a mock agent. Nothing is sent.

## Standalone use

With Pi and this package's JavaScript dependencies already installed, start from the package root:

```sh
pi -e ./extensions/comms/index.ts
```

Then run `/comms` for your saved queue or `/comms demo` for a disposable queue. The built-in demo cannot hand off to an agent, read the real queue, enable queue tools, call models, open live sources or write reminders.

| Command             | Effect                                     |
| ------------------- | ------------------------------------------ |
| `/comms`            | Browse the saved queue                     |
| `/comms refresh`    | Start a bounded read-only Claude collector |
| `/comms refresh pi` | Collect in the current Pi conversation     |
| `/comms status`     | Show coverage, failures and queue location |
| `/comms cancel`     | Stop this session's Claude job             |
| `/comms help`       | Show command help                          |

| Key   | Effect on the selected item                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------- |
| `n`   | Next: edit one line from the suggestion's first sentence. Enter adds it to Reminders and closes the item |
| `d`   | Drop: dismiss locally. No confirm. `u` undoes it                                                         |
| `u`   | Undo the latest decision made in this Pi session, then the one before                                    |
| `/`   | Search. Esc leaves search and keeps the filter. Esc again clears it                                      |
| Enter | Details, then every action                                                                               |

Letters act on the selected item. They type into search only after `/`. Next closes the item only if nothing changed while Reminders ran. Otherwise the action stays in Reminders and the item stays open for another look. A legacy meeting or scratchpad review opens its menu instead, because one reminder must not close its other actions.

Tab switches between Top and Needs you. Ctrl+G shows coverage. Ctrl+L reloads local state. Ctrl+R starts collection or resets demo fixtures. Ctrl+X cancels the running Claude collector. Escape goes back.

Needs you lists every item that needs you, by rank, then oldest first. Rank is the item's priority, except that anything due within 48 hours counts as priority 1. Within rank 1 the nearest deadline leads. A deadline further out never jumps ahead of older items. The Updated column shows `due 5h` or `late 2d` for an item with a deadline. Top shows its first five. Deciding one reveals the next. Search and the source filter apply first. The tabs carry the counts, and the header shows the age of the oldest item. Age runs from the item's latest reopening, then from when Comms first saw it. Items saved before that was recorded use their source time.

Nothing leaves the queue without a way back. Snooze returns the item tomorrow at 09:00. Waiting returns it after three days as "Still waiting?". A newer message reopens a closed item and ends any deferral. ↺ marks an item that reopened that way. `u` undoes a mistaken decision, unless a refresh or another session changed the item since. So there is no view for closed items.

## Priority and deadlines

Priority 1 means it costs you something if ignored until tomorrow: someone is blocked on you, a window closes, or it gets harder to undo. Priority 2 is this week, priority 3 can wait. Collection sets `dueAt` only from a deadline stated in the source, or from the meeting start when the bundled triage finds something to prepare for the next working day. It never invents one. A refresh without a deadline clears the old one.

## One request, one item

The collector refers to every saved item by an eight-character ref instead of retyping its long provider ID, and recently closed items are part of its input. An unknown ref is ignored and counted, never turned into a new item. A mail or Teams request that arrives under a second ID with the same sender and timestamp as a saved item folds into that item. That covers a mail moved to another folder. The collector can also mark one saved item as a duplicate of another, across sources, for example a calendar task block that repeats a mail. A duplicate closes only while it is unchanged, and a newer message reopens it. Source coverage reports merged duplicates and ignored refs.

The finish notice and source coverage name the requests that someone else's reply closed in that run.

## Reply-ready triage

Collection always suggests a concrete next action. It can also prepare a local reply for mail or Teams when the thread and recipient are verified and nothing blocks the answer. A blocker is a missing fact, unreadable evidence, an unverified recipient or ownership, or a decision only you can make. Any blocker withholds the reply and is shown on the item. Residual doubt about whether the ask is still open is shown as uncertainty, one line, and does not withhold the reply. Each refresh reports how many proposals arrived and how many became drafts, in the finish notice and in source coverage. Proposals seed only new or untouched empty drafts. Refresh never replaces your saved wording or resurrects a deliberately cleared draft.

Saved drafts and triage proposals are readable in the thread details and included when you hand off the context. Write or revise the reply in the agent pane. Comms never sends messages or creates remote drafts.

## Open in split

Inside local tmux on macOS, choose **Open in split & copy context**, then Claude, Pi or Codex in the popup over the thread. Esc closes the picker without leaving the thread. The agent opens in a focused right-hand pane in the same window. The same Comms thread stays visible in the original pane. The agent uses its local profile and starts in the configured notes directory or current project.

When the agent's prompt is ready, paste the clipboard and add your notes at `My instructions:`. The clipboard contains only the selected item's source details, labeled Comms summary and any saved draft. Comms never pastes or submits it. The prompt asks for reply text only. Live thread access depends on the agent's connectors, and its normal permissions and history apply after you submit.

Outside tmux, choose **Copy context** and open the agent yourself. The queue and saved draft stay unchanged, and the agent's reply is not imported.

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
    "voiceInstructions": null,
    "reminderList": "Next"
  }
}
```

The bundled triage template lives in `workflows/comms/triage.md`. No private notes checkout is required. A configured notes directory or `PI_COMMS_NOTES_DIR` can supply `.claude/commands/triage.md`. An explicit `triageInstructions` path takes precedence and fails visibly if missing.

`voiceInstructions` points to an optional private file of writing rules for replies, at most 8 KiB. Both collectors receive it inlined as style guidance. An unreadable or oversized file is reported and proposals use the default voice. Existing drafts keep their provenance, which is never evidence that they were sent.

`messageInstructions`, `meetingInstructions`, `remarkableSource` and `notebookName` are still accepted so older configuration files load. Comms no longer uses them. Accepted actions use the configured Reminders list. Calendar windows, snoozes and waiting follow-ups use the configured timezone. Identity labels never replace authenticated-account verification.

## Scheduled refresh

`bin/comms-refresh.mjs` runs one Claude collection outside Pi, with the same read allowlist, triage lock and merge as `/comms refresh`. It needs an installed Pi for its TypeScript loader.

```sh
node bin/comms-refresh.mjs                # one refresh now
node bin/comms-refresh.mjs install 07:00  # weekdays, macOS launchd
node bin/comms-refresh.mjs uninstall
```

The launchd job runs after wake when the Mac slept through the time, and not at all while it is shut down. Install it from the main checkout: it keeps the script path it was installed from, and it refuses a linked git worktree. It records `claude` and `node` as found on PATH, so a Homebrew upgrade does not break it. Each run uses Opus and appends one line to `<Pi agent directory>/comms/refresh.log`, including the titles others closed. Only failures exit with status 1. The queue header shows when sources were last checked and turns to a warning after a day, so a failed morning run shows where you look. Unattended runs use your Claude usage and send the same evidence to Claude as a manual refresh.

## Prerequisites

1. **Default collection:** an existing, signed-in `claude` CLI with reviewed Microsoft 365 and Notion read connectors. Comms does not install connectors, log in, copy credentials or configure accounts. The exact external allowlist is in `triage-guard.mjs`. Unsupported connectors remain unavailable. Claude starts in the configured notes directory, or the package root when none is configured. Trusted Claude startup settings and hooks still apply.
2. **Pi-native collection:** existing read-only tools connected in Pi. Tool discovery uses the actual available names. Missing mail, chat, calendar or ticket access is reported independently, never treated as an empty source.
3. **Apple Reminders:** macOS, `uv` and this terminal's Automation permission for Reminders. The target list must already exist. Comms invokes package-relative `helpers/to_next.py` through `uv run`. No Python dependencies are needed for Reminders.

Local review and collection can run on other platforms. Reminders and source launching are Mac-only.

## Privacy and protections

Queue tools start inactive. Their execution guards reject calls before a user `/comms` action, even if a caller tries invoking them directly. Pi-native refresh enables only its required tools. Collector writes to the queue require the current job token. Demo grants no access to the real queue.

Comms initializes the bundled approval guard even when loaded alone. Collection blocks external writes, including nested calls. The handoff launches a blank agent and never submits a prompt. These are workflow guards, not an OS sandbox. Read-only connector annotations are hints. No automatic remote writes or automatic retries occur.

The Claude collector receives minimal source evidence and retained requests, excluding local reply drafts and legacy items. It uses a non-persistent session, a read allowlist, a 100-turn cap, a 15-minute process limit and a 16 MiB output limit. Cancellation or fatal process errors import nothing. Valid source/account results merge independently. Failed or partial sources keep their checkpoint. Missing requests never imply completion. Evidence-backed resolution applies only to unchanged retained items. Concurrent edits and drafts are preserved.

Notion page fetches never include raw transcripts.

Private state stays at `<Pi agent directory>/comms/queue.json`, respecting `PI_CODING_AGENT_DIR`. Directories use `0700` and files `0600`. Existing paths and item keys are preserved. Atomic writes, revision checks, size limits and locks protect the queue. Corrupt state is reported without replacement. Inspect a lock's PID and remote outcome before removing a stale `write.lock` or `triage.lock`.

Pi-native collection sends evidence to Pi's selected model and retain it in session history. Resolved history and legacy capture images under `comms/remarkable-pages/` are not automatically deleted.

## Offline checks

```sh
node scripts/test.mjs tests/comms*.test.mjs
prettier --check 'extensions/comms/**/*.{ts,mjs,md}' 'workflows/comms/*.md' 'tests/comms*.test.mjs'
```

Tests use temporary state, synthetic records and fake executables. No login, model call, real inbox or Reminders app is needed.
