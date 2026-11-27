# Performance and maintenance tradeoffs

Moving the code to a separate repository does not add a process, network hop or model request. Optional integrations still have their existing costs. No general speedup or zero-regression claim is made without a comparable measurement.

| Feature       | Runtime cost                                                                                                      | Chosen boundary                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Configuration | Small local JSON reads at startup or explicit operations                                                          | No watchers, network configuration or per-token parsing                                        |
| Vim           | In-process input handling                                                                                         | Keep native editor behavior and guarded private APIs. Retest Pi upgrades.                      |
| Voice         | Per-window model worker while warm, capture subprocess and repeated whole-clip inference                          | Initially off unless saved on. Restore without model. Five-minute idle unload. RAM-only audio. |
| Agents        | Presence writes every five seconds. External discovery every five seconds while browsing. UI refresh each second. | Remote disabled without a host. No always-on external discovery daemon.                        |
| dev01         | SSH startup, remote processes and explicit transfers                                                              | One configured host. No automatic synchronization or retries after uncertain launch outcomes.  |
| Approval      | In-process lexical checks and local Git verification for publishing                                               | Keep confirmations and audit writes. It is not a shell interpreter or sandbox.                 |
| Workflows     | In-process checklist/plan logic. Child processes when delegated.                                                  | Reuse the installed Pi example. No second subagent implementation.                             |
| Supervisor    | Up to two live worker processes and their model requests                                                          | Off until enabled. Worker cost is not aggregated into the parent footer.                       |
| Comms         | Claude process startup, connector/network reads, model requests and local queue I/O                               | Explicit refresh. Existing connectors, not another broker service.                             |
| Workstation   | Optional prompt-file reads, injected context tokens, usage writes and QMD work                                    | All private integrations opt-in. Do not broaden memory discovery.                              |
| Web           | Network search and Python extraction startup                                                                      | Optional `uvx` dependencies. First use may acquire packages.                                   |

## Intentional default changes

1. Fast starts off. Supported requests can be slower than an old priority-on default, but do not silently request a more expensive tier. Private configuration can restore priority.
2. Remote discovery is absent until configured. This avoids failed SSH probes on other users' machines.
3. Private memory, style, logging and hooks are off. Enabling memory adds context tokens and can affect prompt-cache reuse, as before.
4. Comms queue tools require a user action. Opening the local demo does not expose the real queue.
5. Voice is initially off unless saved on. New or reloaded sessions restore enabled standby with no worker or capture. Explicit `/voice on` saves the choice and warms the current window only. Recording and optional hold-Space remain separate opt-ins.

## Local voice costs

Voice requires macOS arm64 in interactive Pi outside SSH. It uses existing `ffmpeg` and `uv`, cached Python 3.10, pinned `mlx-audio==0.5.3` and `mlx-community/parakeet-tdt-0.6b-v3`. The [explicit setup command](../extensions/voice/README.md#one-time-setup) can download dependencies and the model as needed. Runtime forces `uv run --offline` and `HF_HUB_OFFLINE=1`. Warming Voice makes no network request or model download and fails if the required caches are missing.

Explicit `/voice on` or the recording shortcut while off saves enabled and warms this window without capture. Saved-on session restore enters standby with no worker or microphone. There is one model worker process group per actively used window, not a shared server. Other already-open windows are not live-synced. New, resumed, forked or reloaded sessions and Pi restarts read the latest choice. Standby restore avoids loading a multi-GiB model in every saved-on window.

After five idle minutes in ready or pending, Voice unloads the entire worker while staying enabled. A pending final remains in RAM. Inserting or cancelling it does not reload the model. Loading, recording and finalizing never idle-unload. The next recording gesture cold-loads and queues capture only while still requested. Hold the key and wait for `● recording` before talking. Releasing early, pressing the toggle shortcut again or Ctrl+C cancels queued capture. `ffmpeg` starts only for capture. Cleanup, errors and idle unload never erase the saved enabled preference.

A recent local review on a 32 GB Mac measured worker physical footprint at about 2.5 GiB ready and 2.8 GiB after decoding, with a 3.9 GiB peak for a 60-second synthetic clip. Warm idle CPU was near zero in a 10-second sample. Ordinary RSS underreports MLX GPU unified-memory allocations. These are bounded local observations, not predictions for every machine, a latency guarantee or evidence of human-speech accuracy.

Audio is 16 kHz mono 16-bit PCM, kept in RAM with a hard 60-second clip limit. After every two seconds of new audio, the worker redecodes the full bounded clip. Finalization makes a fresh whole-clip pass. This avoids overlap merging and word-boundary guesses, but work per pass grows with clip length. Two seconds is an input threshold, not a guaranteed preview cadence. Longer clips can increase preview and finalization latency. Live previews replace provisional text above the editor, while only the complete final is pasted into the draft.

Capture supervision runs independently of inference. Cancel stops the microphone and retires the result immediately. An in-flight MLX decode cannot be safely interrupted, so that call releases its audio input on return. Stale text cannot revive a cancelled request. Startup and finalization deadlines trigger process-group cleanup, with termination and kill escalation even if the `uv` leader has already exited. The worker also bounds stalled capture. A cleanup failure is reported rather than treated as success.

Voice writes no audio files or transcript logs. Pending finals live only in RAM. Inserted text becomes an ordinary Pi draft, and submitted text follows the usual provider and history paths. Local speech recognition does not make Pi local. There is no text-to-speech, always-listening mode or remote microphone capture.

Automated synthetic tests use fake capture/model adapters to exercise control flow and editor integration without a microphone or speech model. The separate local cost and cached-model synthetic checks are manual checks. Actual microphone hardware and human transcription accuracy require an explicit [manual test](../extensions/voice/README.md#verification). No real-microphone accuracy or latency result is claimed here.

## Compatibility costs

Vim touches guarded private editor internals. A conservative fallback preserves ordinary typing when their shape changes, but cannot guarantee compatibility with behavioral changes. Voice integration is exercised against Pi 1.6.1. The Pi 1.5.0 extraction measurements below are historical and do not cover Voice. Retest the relevant suites on Pi upgrades rather than claiming every version works.

After updating the Voice implementation, fully restart Pi. Native JavaScript modules remain cached across `/reload`. Configuration-only edits can use `/reload` after that restart.

Voice's hold shortcut needs Kitty key-release reporting and otherwise falls back to short-press toggling. Optional bare Space needs release reporting too. It uses a 300 ms hold threshold and leaves taps as native typing. The bundled Vim editor permits Space only in INSERT, and the stock editor is supported. Other custom editors require an explicit `acceptsLiteralSpace` getter. Final insertion uses native bracketed paste, not simulated typing, and preserves bundled Vim mode by default. Changed drafts or modal focus defer the final in RAM until explicit insertion at the main prompt.

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

Historical measurements before Voice was added. Five alternating fresh-process samples on macOS, using Pi 1.5.0 and Node 26.8.1:

| Measurement                          | Original source | Standalone package |
| ------------------------------------ | --------------- | ------------------ |
| Median extension load                | 241 ms          | 271 ms             |
| Median resident memory after loading | 131 MiB         | 142 MiB            |

The timing covers loading all ten extension factories after importing Pi's loader. No session, external discovery or model request started. Transpilation caches were not purged. First-sample timings were much larger, so this is not a cold-machine benchmark.

The final sample shows a 30 ms higher median load and roughly 11 MiB more resident memory. Exploratory reruns varied in timing direction, so the loader delta is not a stable prediction. No speedup is claimed. This does not measure sustained memory growth, prompt responsiveness or response latency.
