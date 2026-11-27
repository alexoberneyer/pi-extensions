# Verification

Run from the package root:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run test:python
npm run lint:check
npm run check:release
```

`npm test` uses `scripts/test.mjs` to locate the installed Pi package and start the Node test runner with a temporary HOME, private configuration and explicit environment. Set `PI_TEST_PACKAGE_DIR` for a different installed host. No host credentials or agent-session variables are forwarded.

Target one suite with `node scripts/test.mjs tests/package.test.mjs`. Tests use fake CLIs, fixture projects and local WebSocket/tmux sockets. They do not invoke paid models, real communication sources or your desktop applications. This environment isolation is test hygiene, not a claim of an OS security sandbox.

A fresh GitHub install of the [README pin](../README.md#install) and the full automated checks passed with Pi 1.6.1 and Node 26.8.1. This does not verify real connectors, a live agent's configuration or microphone capture.

## Optional Python codec fixtures

The default Python suite runs without installing packages. Some reMarkable decoding/rendering tests skip unless `rmscene` and Pillow are installed.

For full synthetic codec coverage, use an isolated uv environment:

```sh
uv run --no-project --with rmscene==0.6.1 --with pillow node scripts/test.mjs --python
```

Dependency acquisition requires network access on first use. Notebook fixtures are generated in temporary directories. No desktop copy or tablet is required. Python 3.10 or newer is required.

## Release gate

`npm run check:release` checks the working tree's public-file allowlist and Markdown punctuation, then runs the disclosure guard for obvious credentials, personal home paths and external private matching rules. It excludes ignored dependency/cache directories. It also verifies the npm package contents through a script-free dry run. This is a release guard, not proof that no secret or legal issue exists.

Install the local pre-push check with `python3 scripts/public_repo_guard.py install`.
It inspects outgoing history and commit messages, not only the latest tree.
See [public repository safety](public-repo-safety.md) for private rule setup and
limitations. `npm test` also runs its synthetic Git regression tests.

Before tagging a release:

1. Inspect the exact Git diff and package file list. Keep configuration, queues, drafts, notebooks, session histories and credentials out.
2. Run the full suite against the stated Pi version. Exercise standalone filtered installations and missing optional dependencies.
3. Test a fresh local package installation and rollback before changing a working installation.

The private source repository's Git history is not part of this extraction. No imported private configuration or runtime state is needed to run the tests.

## Extraction verification

Verified locally with Pi 1.5.0, Node 26.8.1 and Prettier 3.8.1:

- Node: 1032 tests passed, none failed or skipped.
- Python: 69 tests passed with the optional codec dependencies present, none skipped.
- All ten extensions load from an actual packed archive after a script-free, runtime-only dependency installation. `ws` resolves inside that installation, not through a parent checkout.
- Formatting and the release-content checks pass.

Real connectors, production services, desktop applications and model calls were not exercised. Live settings and existing extension links were not switched. See [performance](performance.md) for the bounded model-free load comparison.

## Local voice verification

Voice is exercised against Pi 1.6.1. Its automated suites use synthetic data and fake capture/model adapters. Private preference tests use temporary files. Controller tests use fake timers for idle unload and queued cold capture. PTY tests run real Pi in regular and fullscreen modes to verify Vim-safe literal insertion, undo, Space-tap redraw and reload. These automated checks open no microphone and load no speech model.

```sh
node scripts/test.mjs tests/config.test.mjs tests/voice.test.mjs tests/voice-state.test.mjs tests/voice-preferences.test.mjs tests/voice-pty.test.mjs
npm run test:python
npm run lint:check
```

### Explicit manual lifecycle checks

After updating this implementation, fully restart Pi. Native JavaScript module caching means `/reload` alone does not load the update. Use private configuration outside the checkout. Installation should not create a Voice state preset.

1. Run `/voice on` once after restarting. Confirm it saves enabled in `voice-state.json` beside the selected private config and warms only this window without capture. The default state path is `~/.config/pi-extensions/voice-state.json`. Check that `XDG_CONFIG_HOME` and `PI_EXTENSIONS_CONFIG` relocate it appropriately. It should contain only the enabled boolean and schema-version metadata.
2. Start a new session, resume, fork, reload, open another window and restart Pi. Each saved-on session should show `standby` with no model worker or microphone. Run `/voice off` to save disabled. Already-open windows should not live-sync, but new or reloaded sessions should read the latest choice. Cleanup and errors must not erase it. Headless, RPC, SSH and unsupported environments must not launch workers.
3. Warm Voice explicitly, then leave it ready for five idle minutes. Confirm the entire worker exits while Voice stays enabled in standby. Only with capture authorized, repeat with a pending final: keep the text in RAM after unload, then insert or cancel without restarting a model. Loading, recording and finalizing must not idle-unload.
4. Only with microphone capture authorized, hold the recording key from standby and wait for `● recording` before talking. Release during loading and confirm capture never starts. In toggle mode, confirm a second press cancels queued capture. Confirm Ctrl+C discards queued or active speech while still reaching native editor-clear and double-press-exit handling. Escape remains unchanged. `/voice cancel` stays available without a dedicated discard key or widget hint.

### Separate cached-model checks

A separate local check transcribed synthetic English and German speech with the cached Parakeet model. The actual offline worker also reached ready and its process group shut down without starting capture. A local physical-footprint review used synthetic audio, not microphone capture. See [local Voice costs](performance.md#local-voice-costs) for its bounded measurements. These manual checks are separate from the model-free automated suites. They do not establish real-microphone accuracy or terminal-specific physical hold/release behavior. Those remain explicit manual checks in the [Voice instructions](../extensions/voice/README.md#verification).
