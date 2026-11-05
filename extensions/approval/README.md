# Approval policy

Reduce duplicate confirmations without granting persistent permission.
This is a workflow guard, not a sandbox or a security boundary.

## Install and configure

From a cloned package, run `pi install /absolute/path/to/pi-extensions`, then
`/reload`. For a single-session check from the package root:

```sh
pi -e ./extensions/approval/index.ts
```

Workflows and supervisor initialize this bundled guard themselves, even when
package filters exclude the standalone approval entry. A shared event-bus
readiness query prevents duplicate confirmations in either load order. Missing
or invalid configuration keeps integrated tools blocked, not silently unguarded.

User configuration defaults to `~/.config/pi-extensions/config.json`, or
`$XDG_CONFIG_HOME/pi-extensions/config.json`. `PI_EXTENSIONS_CONFIG` selects an
explicit file. No project-local configuration is read.

```json
{
  "approval": {
    "protectedCommands": ["service-cli", "admin-cli"]
  }
}
```

The default list is empty. Entries are executable basenames, not paths or shell
snippets. Configured commands require confirmation unless their first operation,
or entity/operation pair, is recognized as read-only. Recognized reads include
`get`, `list`, `search`, `status`, `show`, `view`, `describe`, help and version.
Unknown operations, unknown leading flags and empty invocations fail closed.
Generic filesystem, Git, cloud/database and remote-write checks remain active.
This is lexical classification, not a complete understanding of any CLI.

## Explicitly requested publishing

Direct requests such as `please push` and `please commit, merge if necessary,
push, pull and delete stale branches` can authorize one ordinary local push per
edited repository. A leading `yes`, as in `yes, please commit and push`, is accepted.
Discussion, quoted instructions, negation and conditional requests do not grant
permission. Bare questions such as `push?` are not authorization.

Successful file edits in the preceding user task establish the repository scopes.
Symlinks resolve to the actual edited file. If there were no successful edits,
only the current project is used. Linked worktrees share one scope through their
canonical Git common directory. Separate edited repositories each receive their
own grant. An unedited clone cannot inherit a grant, even with the same remote
URL. Edits across linked worktrees require matching push destinations and a clear
target branch. Ambiguous or missing repositories keep the normal confirmation.

The grant pins `origin`'s push URL and a branch. A merge request uses the known
remote default branch. Otherwise it uses the current or explicitly named branch.
Changed remotes, detached HEAD, multiple push URLs and implicit mirror/tag
publication keep the normal confirmation. Relative local push URLs and HTTP URLs
containing credentials also retain confirmation. These checks apply to
worktree-specific Git configuration.

Use a separate standalone command for each repository:

```sh
git -C /absolute/repository/path push origin main
```

`HEAD:main` is also supported when the current branch is `main`. One optional
`-u` or `--set-upstream` flag is accepted. Compound shell commands, alternate
executables, wrappers and other flags are not exempt. The model receives a
guideline to use the standalone form.

Upstream setup runs only after a successful pinned push. It requires the standard
origin fetch mapping and repository-local tracking settings. Worktree-specific
tracking overrides, custom mappings and symbolic tracking refs retain confirmation.
Generated local commands check the destination and configuration around an
exact-old-tip tracking-ref update. Git's native upstream setup honors
`branch.autoSetupRebase`. Configuration writes use Git's individual locks, not
an atomic transaction with publication. A bookkeeping failure reports that the
push succeeded but upstream setup did not complete. It does not authorize
another push.

Accepted commands are rewritten to the pinned push URL and exact commit/refspec.
Inherited `GIT_*` overrides are removed without copying their values into the
command. Mirror pushes, automatic tag publication and recursive submodule pushes
are disabled in the generated invocation. Changing `origin` or advancing the
local branch after validation cannot redirect or widen that attempt.

Each push grant is consumed before its attempt without consuming other repositories'
grants. A failed push does not authorize a retry. All grants expire at the next
input, final agent settlement, actual plan-mode changes, session navigation or
reload. Checklist refreshes do not revoke them. They are never
restored from saved approvals. Injected input, streaming messages, headless
processes and nested tool calls cannot inherit them. Supervisor worker instructions
also cannot grant publication. Worker approvals must come through the user's
confirmation dialog, not another model's request.

Force pushes, production changes and outgoing chat retain their confirmations.
Email stays draft-only. Ordinary commits, fast-forward merges and safe local
branch cleanup do not need extra confirmation.

## Verified stale remote branches

`delete stale branches`, alone or in the publishing request, authorizes narrow
cleanup in the same repository scopes. Use one branch per standalone command:

```sh
git -C /absolute/repository/path push origin --delete feature/finished
```

Only remote-tracking branches present when the request arrived are candidates.
The guard excludes the remote default branch and branches checked out in any
local worktree. A branch qualifies if its tip is an ancestor of the published
default branch, or every path it changed matches that default branch, including
file modes and gitlinks. Local replacement objects and submodule-ignore settings
cannot weaken the proof. The second proof handles squash merges conservatively.

Before allowing deletion, the guard checks that the tracking tip is unchanged
and both live refs at the pinned push destination match the checked branch and
default-branch commits. It rewrites the command to the pinned push URL and a
deletion refspec with `--force-with-lease=refs/heads/<branch>:<checked-tip>`.
This is a conditional
single-ref deletion, not permission to force-push content. Git rejects it if the
remote branch advances after verification.

Each repository/branch/tip grant is single-use. Unknown or advanced refs, unmerged
changes, different remotes, wrappers and compound scripts retain confirmation.
Cleanup grants share the push grants' expiry and cannot be persisted or inherited.

## Permission summary

- **No extra dialog:** ordinary inspection, source edits, tests and local commits,
  fast-forward merges and safe local branch cleanup. Explicit requests can grant
  one ordinary push per edited repository and verified stale remote-branch
  deletions, including through linked worktrees. Reviewed MCP inspections below
  also skip confirmation.
- **Fresh confirmation:** pushes and remote deletions outside those grants, destructive Git or
  filesystem commands, privileged commands, recognized cloud/database mutations,
  configured protected commands not recognized as read-only, credential or
  Git-internal edits, recognized remote GitHub/HTTP writes, MCP mutations or tools
  without read-only annotations, and every recognized outgoing chat message.
- **Blocked:** recognized email sends. Create drafts instead. In headless mode,
  operations needing confirmation are blocked. Plan mode blocks model-issued
  Bash and mutating or unclassified tools rather than opening a dialog.

## Reviewed MCP inspections

These exact operations skip confirmation, including in headless and plan modes:

- `mcp__notion_api__API_query_data_source`: filters and reads a data source through
  Notion's POST query endpoint. It does not update the data source.
- `mcp__rea__search_strings`: searches the active analysis target. REA marks it
  non-read-only because it records session evidence, not because it changes the
  target or writes files.

These reviewed classifications take precedence over missing or false read-only
hints. An explicit `destructiveHint: true` still requires approval, or blocks in
plan mode. No server-wide or verb-based exemption applies. REA open/close,
snapshot saves, Notion mutations and unknown operations retain their checks.

These are pattern-based checks, not comprehensive enforcement. Scripts, alternate
executables and other unrecognized paths can bypass them. The assistant's safety
instructions still apply even when the guard does not display a dialog.

## Verified temporary-file cleanup

The supported direct-shell idiom is intentionally narrow:

```sh
bundle=$(mktemp /tmp/approval-test.XXXXXX.bundle)
trap 'rm -f -- "$bundle"' EXIT
cat "$bundle"
```

The guard recognizes a literal `mktemp` file allocation and its exact single-file
EXIT cleanup in the same straight-line scope. It rejects reassignment, file
replacement by `mv`, function overrides, recursive deletion and unrecognized
syntax. Only known simple file operations and `git bundle` operations are admitted.
SSH, privileged commands and other execution wrappers are not part of this proof.
It does not exempt existing paths merely because they are under `/tmp`.

Only the verified trap is replaced in an analysis-only copy. The actual command
is unchanged. Other risky actions still require confirmation. Trap bodies are
checked as deferred shell commands, including when ownership cannot be proved.

A small, static Node heredoc wrapper is also recognized. The earlier dynamic
Node/SSH Git-bundle script is not. Opaque scripts keep their confirmation rather
than relying on guessed ownership. Prefer the direct shell form above.

## Private decision log

Durable sessions write categorical metadata to:

```text
<Pi agent directory>/approval-log/<session-id>.jsonl
```

The default directory is `~/.pi/agent/approval-log/`. Its mode is `0700`, and log
files use `0600`. Symlinked or hardlinked log files are refused. The Pi agent
directory override is respected. In-memory SDK sessions keep custom audit
entries in their session rather than writing a durable file.

Each record contains a version, timestamp, tool-call ID, optional parent ID,
tool name, phase and reason. Decision records also contain an outcome. There
are no command bodies, tool arguments, repository URLs, paths or user messages.

A `prompt` record is written before requesting confirmation. A `decision` record
then distinguishes allowed, denied, blocked and UI-error outcomes. Explicit
request and verified-cleanup exemptions are logged without a prompt record.
An unrecognized ordinary read does not create an audit record.

Count `phase: "prompt"` to audit confirmation requests. An error outcome can
mean the UI failed before displaying the dialog. If a required audit write fails
or is incomplete, the tool is blocked rather than silently allowed. A partial
last line prevents further appends until the log is repaired.
