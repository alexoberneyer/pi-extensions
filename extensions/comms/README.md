# Comms for Pi

A local review queue for communication requests, meeting follow-ups and optional reMarkable captures. Nothing polls on startup. Browsing saved items makes no model or connector calls.

![Comms review queue with request details, actions and source coverage, shown with demo data](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/comms-demo.gif)

## Standalone use

With Pi and this package's JavaScript dependencies already installed, start from the package root:

```sh
pi -e ./extensions/comms/index.ts
```

Then run `/comms demo`. Demo uses disposable, memory-only data. It cannot read the real queue, enable queue tools, call models, open live sources or write reminders. Copying a demo draft is an explicit clipboard action.

| Command                     | Effect                                     |
| --------------------------- | ------------------------------------------ |
| `/comms`                    | Browse the saved queue                     |
| `/comms refresh`            | Start a bounded read-only Claude collector |
| `/comms refresh pi`         | Collect in the current Pi conversation     |
| `/comms capture remarkable` | Capture changed notebook pages for review  |
| `/comms next`               | Read the configured Apple Reminders list   |
| `/comms status`             | Show coverage, failures and queue location |
| `/comms cancel`             | Stop this session's Claude collector       |
| `/comms help`               | Show command help                          |

Tab changes views. Enter opens an item and its actions. Ctrl+G shows coverage. Ctrl+L reloads local state. Ctrl+R starts collection, reads Reminders in the Next view, or resets demo fixtures. Escape closes the view. Ctrl+S explicitly saves an edited draft or adds a reviewed reminder.

## Reply-ready triage

Collection always suggests a concrete next action. It can also prepare a local reply for mail or Teams when the thread and recipient are verified and the answer needs no missing facts, user decision or invented commitment. Otherwise the item names the blocker. Proposals seed only new or untouched empty drafts. Refresh never replaces your saved wording or resurrects a deliberately cleared draft.

Open an item to read its proposed action and unsent draft. Edit locally with Ctrl+S, or choose **Review & send reply** for Teams or **Review & create Outlook draft** for mail. There is no separate accept-and-submit step. Pi verifies the current account and conversation, then the bundled approval dialog shows the exact final connector payload. Saved wording is preserved, including whitespace. Email is never sent. The queue reopens after a normally completed reply or AI-drafting job unless other input or work needs focus.

Reply execution uses Microsoft 365 tools already connected **in Pi**, not the Claude collector's separate connections. Supported operations are `outlook_create_draft`, `chat_message_send` and `chat_message_post` in the reviewed Microsoft 365 namespaces. Only recognized plain-text schemas run. An unsupported or unavailable connector leaves the text local for copying. No connector setup is attempted.

Account/thread verification and reply readiness are model judgments. Changed or uncertain context must stop the job. Final payload approval remains yours. A connector-reported success is not independent delivery verification, and never resolves the underlying queue item automatically.

## Configuration

Use the package's user configuration at `$XDG_CONFIG_HOME/pi-extensions/config.json`, defaulting to `~/.config/pi-extensions/config.json`. `PI_EXTENSIONS_CONFIG` selects another file. Malformed configuration is an error.

```json
{
  "identity": { "name": "the authenticated user", "timeZone": "UTC" },
  "comms": {
    "notesDirectory": null,
    "triageInstructions": null,
    "messageInstructions": null,
    "meetingInstructions": null,
    "reminderList": "Next",
    "remarkableSource": null,
    "notebookName": "Scratchpad"
  }
}
```

Neutral triage, message and meeting templates ship in `workflows/comms/`. No private notes checkout is required for demo or normal collection. Explicit instruction paths override bundled templates. For compatibility, a configured notes directory or `PI_COMMS_NOTES_DIR` can supply `.claude/commands/triage.md`, `.claude/commands/message.md` and `.claude/skills/paste-meetings/SKILL.md`. Explicit instruction paths take precedence. The environment variable overrides the notes directory only. Missing legacy files use bundled templates. An unreadable explicit meeting override makes that optional source unavailable without blocking other sources. Missing required overrides fail visibly.

Filing meeting or notebook notes requires an explicit notes directory. Meeting and notebook handoffs prepare a proposal in the editor, never submit it or approve writes. Accepted actions use the configured Reminders list. Calendar windows and tomorrow-at-09:00 snoozes use the configured timezone. Identity labels never replace authenticated-account verification.

## Prerequisites

1. **Default collection:** an existing, signed-in `claude` CLI with reviewed Microsoft 365 and Notion read connectors. Comms does not install connectors, log in, copy credentials or configure accounts. The exact external allowlist is in `triage-guard.mjs`. Unsupported connectors remain unavailable. Claude starts in the configured notes directory, or the package root when none is configured. Trusted Claude startup settings and hooks still apply.
2. **Pi-native collection:** existing read-only tools connected in Pi. Tool discovery uses the actual available names. Missing mail, chat, calendar, tickets or meeting access is reported independently, never treated as an empty source.
3. **Apple Reminders:** macOS, `uv` and this terminal's Automation permission for Reminders. The target list must already exist. Comms invokes package-relative `helpers/to_next.py` through `uv run`. No Python dependencies are needed for Reminders.
4. **reMarkable:** macOS, `uv` and a synced local desktop copy. `remarkableSource` overrides its standard macOS location. `rmscene` and Pillow are optional capture-only dependencies resolved by `uv run`. The source stays read-only. Initial discovery requires exactly one live notebook matching `notebookName`, ignoring case. Its UUID stays pinned after the first save, including after renaming. Handwriting needs an image-capable Pi model. At most five changed pages are transcribed per command.

Local review and collection can run on other platforms. Reminders and the Comms desktop-capture command are Mac-only. Source launching is Mac-only. The Python capture helper also accepts an explicit source path for offline use.

## Privacy and protections

Queue tools start inactive. Their execution guards reject calls before a user `/comms` action, even if a caller tries invoking them directly. Pi-native refresh and selected AI actions enable only their required tools. Mutations also require the current job token or selected-item revision. Demo grants no access to the real queue.

Comms initializes the bundled approval guard even when loaded alone. Collection and drafting block external writes, including nested calls. These are workflow guards, not an OS sandbox. Read-only connector annotations are hints. Selected reply jobs permit only one wrapper-owned write through normal tool validation and approval, with a final item/revision check after confirmation. Email remains draft-only. Chat sends require confirmation of the exact message. Permission checks remain active and fail closed. No automatic remote writes or automatic retries occur.

Reply jobs claim the selected item across sessions with a private `reply-*.lock`. A `reply-*.jsonl` receipt prevents repeating the same saved wording against the same source context, even after draft-revision changes. Connector-reported success releases the item-wide claim, so a separately reviewed new reply can run. Uncertain execution keeps both claim and receipt: check the source and inspect both files before manually clearing them. There is no expiry or automatic lock stealing.

A job that stops before attempting delivery releases its claim. A proven pre-execution validation or approval block also releases it, but consumes that job's authorization. Trying again requires a new explicit review action.

The Claude child receives minimal source evidence and retained requests, excluding local reply drafts and notebook captures. It uses a non-persistent session, a read allowlist, a 100-turn cap, a 15-minute process limit and a 16 MiB output limit. Cancellation or fatal process errors import nothing. Valid source/account results merge independently. Failed or partial sources keep their checkpoint. Missing requests never imply completion. Evidence-backed resolution applies only to unchanged retained items. Concurrent edits and drafts are preserved.

Meeting refresh reads summaries, never raw transcripts. Sensitive content should produce a neutral review link. These are model judgments, not a mechanical content-redaction guarantee.

Private state stays at `<Pi agent directory>/comms/queue.json`, respecting `PI_CODING_AGENT_DIR`. Directories use `0700` and files `0600`. Existing paths and item keys are preserved. Atomic writes, revision checks, size limits and locks protect the queue. Corrupt state is reported without replacement. Inspect a lock's PID and remote outcome before removing a stale `write.lock`, `triage.lock` or `remarkable-next.lock`.

Pi-native collection, AI drafting, selected reply verification and notebook transcription send evidence to Pi's selected model and retain it in session history. Captured PNGs stay under `comms/remarkable-pages/`. Old images and resolved history are not automatically deleted. Mixed typed/ink pages need original-layout review. Missing or crossed-out text never completes reminders.

## Offline checks

```sh
node scripts/test.mjs tests/comms.test.mjs tests/comms-triage.test.mjs tests/comms-proposed-replies.test.mjs tests/comms-reply.test.mjs tests/comms-approval.test.mjs
npm run test:python
prettier --check 'extensions/comms/**/*.{ts,mjs,md}' 'workflows/comms/*.md' 'tests/comms*.test.mjs'
```

Tests use temporary state, synthetic records and fake executables. Optional Python codec tests skip when their dependencies are absent. No login, model call, real inbox, notebook data or Reminders app is needed.
