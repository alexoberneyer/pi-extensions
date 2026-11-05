# Workstation context

Optional private style, Claude project-memory lookup, resource paths, usage logging and QMD refresh. Everything is off by default. No private style, memory index, skill collection or QMD hook is bundled.

Enable integrations in the private configuration, then `/reload`:

```json
{
  "workstation": {
    "memory": true,
    "styleFile": "~/private/style.md",
    "skillPaths": ["~/shared-skills"],
    "promptPaths": ["~/private/prompts"],
    "usageLog": "~/private/logs/usage.jsonl",
    "qmdHook": "~/private/qmd-refresh.sh"
  }
}
```

Memory lookup follows the canonical working directory and its ancestors. It does not use sibling projects. The default memory root is `~/.claude/projects`; `memoryDirectory` can override it. Only the matching `memory/MEMORY.md` is injected. Topic files remain on-demand reads.

Style and memory contents are read before an agent run, not on every streamed token. Injected content is sent to the selected model provider and consumes context. Keep sensitive material scoped appropriately. Configuration paths refresh on `/reload`.

Usage logging is opt-in through `usageLog` or `SKILL_USAGE_LOG`. It records names, session ID and cwd, never invocation arguments or memory contents. It is not proof that a workflow completed. Log parent directories are created with `0700` and files with `0600`.

The configured QMD hook is trusted local executable code. It runs asynchronously only in the TUI. `PI_QMD_REFRESH=0` disables it. Shutdown terminates the owned process group. No watcher, scheduling daemon or QMD installation is included.

Resource paths refer to the user's installed skills and prompt templates. Missing directories are omitted. They do not grant connector access or install third-party assets.
