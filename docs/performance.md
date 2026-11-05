# Performance and maintenance tradeoffs

Moving the code to a separate repository does not add a process, network hop or model request. Optional integrations still have their existing costs. No general speedup or zero-regression claim is made without a comparable measurement.

| Feature       | Runtime cost                                                                                                      | Chosen boundary                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Configuration | Small local JSON reads at startup or explicit operations                                                          | No watchers, network configuration or per-token parsing                                       |
| Vim           | In-process input handling                                                                                         | Keep native editor behavior and guarded private APIs. Retest Pi upgrades.                     |
| Agents        | Presence writes every five seconds. External discovery every five seconds while browsing. UI refresh each second. | Remote disabled without a host. No always-on external discovery daemon.                       |
| dev01         | SSH startup, remote processes and explicit transfers                                                              | One configured host. No automatic synchronization or retries after uncertain launch outcomes. |
| Approval      | In-process lexical checks and local Git verification for publishing                                               | Keep confirmations and audit writes. It is not a shell interpreter or sandbox.                |
| Workflows     | In-process checklist/plan logic. Child processes when delegated.                                                  | Reuse the installed Pi example. No second subagent implementation.                            |
| Supervisor    | Up to two live worker processes and their model requests                                                          | Off until enabled. Worker cost is not aggregated into the parent footer.                      |
| Comms         | Claude process startup, connector/network reads, model requests and local queue I/O                               | Explicit refresh. Existing connectors, not another broker service.                            |
| Workstation   | Optional prompt-file reads, injected context tokens, usage writes and QMD work                                    | All private integrations opt-in. Do not broaden memory discovery.                             |
| Web           | Network search and Python extraction startup                                                                      | Optional `uvx` dependencies. First use may acquire packages.                                  |

## Intentional default changes

1. Fast starts off. Supported requests can be slower than an old priority-on default, but do not silently request a more expensive tier. Private configuration can restore priority.
2. Remote discovery is absent until configured. This avoids failed SSH probes on other users' machines.
3. Private memory, style, logging and hooks are off. Enabling memory adds context tokens and can affect prompt-cache reuse, as before.
4. Comms queue tools require a user action. Opening the local demo does not expose the real queue.

## Compatibility costs

Vim touches guarded private editor internals. A conservative fallback preserves ordinary typing when their shape changes, but cannot guarantee compatibility with behavioral changes. Supporting Pi 1.5.0 explicitly is preferable to claiming every version works.

Codex app-server discovery and Claude native agent discovery depend on external CLI interfaces. A changed interface should show unavailable, not guessed status. Platform-specific desktop operations remain platform-specific. Publishing the code does not make Apple Reminders portable to Linux.

The largest new cost is maintenance: configuration contracts, fixture coverage and dependency updates. Do not add a daemon, universal adapter framework or cross-platform desktop rewrite merely to distribute the package.

## Compare like with like

Use the same machine, Pi version, model, reasoning and enabled features when comparing the old checkout and this package. Separate these measurements:

1. Cold load and repeated no-session extension discovery.
2. Prompt input/render latency with the same Unicode and paste fixtures.
3. Agents dashboard refresh, idle CPU/memory and subprocess counts, with remote discovery both off and configured.
4. Prompt size/cache behavior and delegated worker usage, if model-backed comparisons are explicitly authorized.

Model-free test durations are not model-response latency benchmarks. Disabled integrations and Fast-off defaults are not fair comparisons against an old installation with those features enabled.

## Local extraction check

Five alternating fresh-process samples on macOS, using Pi 1.5.0 and Node 26.8.1:

| Measurement                          | Original source | Standalone package |
| ------------------------------------ | --------------- | ------------------ |
| Median extension load                | 241 ms          | 271 ms             |
| Median resident memory after loading | 131 MiB         | 142 MiB            |

The timing covers loading all ten extension factories after importing Pi's loader. No session, external discovery or model request started. Transpilation caches were not purged. First-sample timings were much larger, so this is not a cold-machine benchmark.

The final sample shows a 30 ms higher median load and roughly 11 MiB more resident memory. Exploratory reruns varied in timing direction, so the loader delta is not a stable prediction. No speedup is claimed. This does not measure sustained memory growth, prompt responsiveness or response latency.
