# Supervised Pi workers

Run `/supervisor on`, then ask Pi to delegate a bounded task. You keep one primary
conversation. Workers keep their own conversations and report results back.

This is the first slice: local Pi workers in the supervisor's project directory.
No Claude Code/Codex control adapters, custom daemon or native worker terminal.
The existing `/agents` dashboard stays independent and read-only when browsing.

## Start

Install the cloned package, then run `/reload` in Pi and `/supervisor on`:

```sh
pi install /absolute/path/to/pi-extensions
```

Or load it for one session from the package root:

```sh
pi -e ./extensions/supervisor/index.ts --supervise
```

A filtered supervisor-only installation initializes bundled approval itself.
Loading standalone approval too does not add a second confirmation dialog.
[Approval configuration](../approval/README.md#install-and-configure) is user-level
and optional. `approval.protectedCommands` adds executable names whose mutations
and unrecognized operations require confirmation. Invalid configuration fails
closed. No company-specific executable list or personal installation path is used.

Example request:

> Delegate an investigation of the failing import test. Do not edit files.
> Return the exact failing assertion, the relevant source paths and a proposed fix.

The model-facing `supervisor` tool requires a name, objective, scope and acceptance
criteria for every launch. Follow-up instructions reuse the worker's conversation.
New worker processes use the supervisor's selected provider/model and thinking level.
Parent conversation history is not copied. A parent project-trust denial is also
applied to the worker. Workers load their own normal Pi context,
skills and trusted resources, plus this extension's worker and approval guards.
No permission bypass or project-trust elevation is added. Worker usage is recorded
in worker sessions, not aggregated into the parent's token/cost totals.

The supervisor enables only in the interactive TUI. Loading the extension does
not start a worker. Enabling it can allow additional model calls and their usual
usage charges. At most two worker processes stay live, with eight saved workers
per parent session. Stop an idle worker to free a process slot.

## Inspect and intervene

Run `/supervisor` to select a worker and an action. These commands also work:

| Command                           | Action                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `/supervisor status`              | Show this session's workers and ownership                                     |
| `/supervisor inspect <id>`        | Open a scrollable transcript snapshot                                         |
| `/supervisor take <id>`           | Interrupt the worker and give you control                                     |
| `/supervisor send <id> [message]` | Send your instruction after taking control. Opens an editor without a message |
| `/supervisor return <id>`         | Interrupt pending manual work and return control to the supervisor            |
| `/supervisor input <id>`          | Answer a pending worker approval or question yourself                         |
| `/supervisor stop <id>`           | Stop its process, retaining its conversation                                  |
| `/supervisor off`                 | Stop all workers and disable supervision                                      |

The supervisor cannot send instructions to a human-controlled worker. Returning
control delivers the latest instruction and result to the supervisor automatically.
It never replays your last instruction. A later explicit `send` can restart a
stopped worker using the same transcript. A running worker must settle or be
explicitly stopped before another instruction is sent. Live steering and slash
commands inside worker messages are deliberately unsupported in this first slice.

Inspection does not create another writer. It shows text and tool results, not
thinking or tool-call arguments. The inspector is a bounded snapshot, not a live
native Pi terminal. `/agents` can discover RPC workers through its existing
heartbeat registry, but those workers do not own an attachable tmux pane.

Worker confirmation dialogs are never answered by a model. The parent shows a
notification and a needs-input widget. `/supervisor input <id>` forwards your
answer. Closing a worker cancels its pending dialogs before aborting it.

## What results mean

Workers call `worker_report` with a completion claim or a blocker. Completion
claims require evidence. The supervisor receives an event only after the worker
settles, including retries and queued work. No model polling is needed. Previews
are bounded and include the full transcript path. Results waiting during a parent
run are delivered at settlement. If that parent run was aborted, delivery does
not restart it. Your next prompt can use the delivered evidence.

- `reported`: the worker claims completion. The supervisor must verify it.
- `blocked`: the worker reported a blocker. Its question is in the report.
- `needs-review`: the worker stopped without a structured report.
- `error`: a process, protocol, extension or final model error was observed.
- `stopped` / `interrupted`: work was deliberately stopped or did not survive a restart.

A launch acknowledgement is not completion. Neither idle status nor a report
proves the task is correct. Inspect relevant diffs, tests and source evidence.
Worker output is untrusted evidence, not instructions or authorization.

## Lifecycle and safety

1. Workers are owned by this parent session. The supervisor never adopts arbitrary
   sessions discovered by `/agents`. Model and human mutations share one queue.
2. Workers share the current project directory. Scope is a workflow restriction,
   not filesystem isolation. Use disjoint file scopes for concurrent edits. For
   isolated code worktrees, start the supervisor inside the intended worktree.
   Worktrees do not include gitignored personnel files and are not security sandboxes.
3. Workers cannot use the `subagent` or `supervisor` tools. The standard approval
   guard is explicitly loaded from this package, never selected from an arbitrary
   user extension directory. Before the first task, the manager checks session
   identity and both guard-registration markers through model-free RPC commands.
   Missing or broken guards stop the worker without dispatching the task. The
   worker also blocks tools if approval readiness disappears. This is still a
   workflow guard, not a security boundary. Shell commands can bypass patterns. Use real sandboxes and scoped
   credentials for untrusted work. A worker cannot inherit permission to publish
   merely because its parent was allowed to publish a different change.
4. Closing, reloading or replacing the parent stops its workers. Conversation
   files survive. Reopening the parent restores metadata and the opt-in setting,
   but never restarts a worker or repeats an instruction automatically. Parent
   Ctrl+C does not stop workers already dispatched in the background. Use `stop`
   or `off`. Stopping cannot undo external effects already performed.
5. Launch, prompt or readiness failures are not retried automatically. A lost
   acknowledgement can have an unknown outcome. Inspect before explicitly retrying.

Private storage is `<Pi agent directory>/supervisor/<parent-id-hash>/`. Directories
use mode `0700`, state files use `0600`, and updates are atomic. Worker session
files follow Pi's own persistence behavior and may contain sensitive task data.
Nothing is copied into git. This adds no cross-machine synchronization.

An exclusive `lease.json` refuses a second cooperating supervisor. Worker PIDs
and transcript identities are checked before restart. Never open a worker's
session file in another Pi process while it is owned here. This lease cannot
prevent an unrelated process from bypassing the supervisor and opening the file.

After a crash, the lease is intentionally not reclaimed automatically. The error
names its path. Check the lease's PID and every saved worker PID. Only after all
are gone, remove that specific lease file and enable supervision again. A live
or ambiguous PID is never signalled or replaced. A missing or changed transcript
is refused rather than silently replaced with a new conversation.

## Verify

From the package root, with a compatible Pi installation:

```sh
PI_TEST_PACKAGE_DIR=/absolute/path/to/pi-coding-agent \
  node scripts/test.mjs tests/supervisor.test.mjs
```

The runner provides a temporary HOME and an allowlisted environment. It does not
load live integrations or call a model.

Tests use fake RPC workers and temporary agent directories. Real-Pi protocol
checks load explicit fixture/worker-guard extensions, disable automatic
network/MCP access and never call a model or inspect user credentials.
