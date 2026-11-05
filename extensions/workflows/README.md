# Workflows

Read-only planning, a branch-aware agent checklist and Pi's shipped subagent example.

## Install

Install the cloned package and run `/reload`:

```sh
pi install /absolute/path/to/pi-extensions
```

For a single-session check from the package root:

```sh
pi -e ./extensions/workflows/index.ts --plan
```

A workflows-only package filter still initializes bundled approval. Loading
standalone approval or supervisor alongside it does not duplicate confirmations.
Pi's `getExamplesPath()` locates the shipped subagent example. No personal or
managed-install path is required. `PI_PARITY_PACKAGE_DIR` is an explicit package
directory override for compatibility checks.

## Planning and tasks

1. Run `/plan on` to block model-issued Bash and mutating or unclassified tools.
   Use `read`, `grep`, `find` and `ls` to inspect files.
2. Run `/plan off` to execute. Approval checks remain active.
3. Use the `todo` tool for agent implementation steps. `/todos` displays them.
   Do not turn personal commitments into agent tasks.

`--plan` forces planning at process startup. Saved planning state and tasks
restore from the active session branch. An explicit `/plan off` survives reload.
The legacy `dotfiles-workflows` state key and `dotfiles:plan-mode` event remain
compatible with earlier sessions.

## Configuration and safety

[Approval configuration](../approval/README.md#install-and-configure) is optional
and user-level. Set `approval.protectedCommands` for additional executable names.
Unknown operations under those executables require confirmation. Invalid
configuration or unavailable approval registration blocks integrated tools.
If the installed Pi distribution lacks the subagent example, planning and
approval stay loaded and the UI reports the unavailable example.

These are workflow guards, not a sandbox or a security boundary. Extensions and
workers have the process's operating-system permissions. Shell classification
cannot recognize every mutation. Load only trusted extensions and agent
instructions. Use scoped credentials and real isolation for untrusted work.
Headless operations needing approval are blocked. Subagents use Pi's own
user/project agent-discovery and trust behavior.

## Verify

```sh
PI_TEST_PACKAGE_DIR=/absolute/path/to/pi-coding-agent \
  node scripts/test.mjs tests/approval.test.mjs tests/approval-temp.test.mjs
```

The runner sanitizes HOME and the environment. Tests use fixtures, not live
integrations or model calls.
