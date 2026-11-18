# Local voice dictation

Dictate into Pi's main prompt on macOS arm64, outside SSH. Voice starts off. `/voice` toggles the feature and warms the local model when enabling it, but does not open the microphone. Recording needs a separate gesture or `/voice start` once ready.

No text-to-speech, always-listening mode or remote capture. Local speech recognition does not make the rest of Pi local.

## One-time setup

1. Install `ffmpeg` and `uv` separately and make them available on `PATH`. They are optional system dependencies, not bundled npm dependencies. Use a local interactive terminal on an Apple silicon Mac.
2. Explicitly cache Python 3.10, `mlx-audio==0.5.3` and the Parakeet model:

   ```sh
   uv run --no-project --python 3.10 --with mlx-audio==0.5.3 python -c 'from mlx_audio.stt import load; load("mlx-community/parakeet-tdt-0.6b-v3")'
   ```

   This setup command downloads dependencies and the model as needed and populates their caches. It does not install `ffmpeg`. Review its network and disk use before running it.

3. Load Voice through the package's `pi config` selection and run `/reload`. To try the source checkout without installing it, run `pi -e ./extensions/voice/index.ts` from the repository root. Do not load both copies.
4. Run `/voice on` at the main prompt and wait for `ready`. On the first explicit recording, grant microphone permission to the terminal application in macOS System Settings → Privacy & Security → Microphone. Do not bypass macOS privacy controls.

Runtime startup forces `uv run --offline` and `HF_HUB_OFFLINE=1`. `/voice` does not download models or use the network. Missing Python, dependency or model caches cause an error instead. Keep the setup and runtime cache locations consistent.

## Record and review

1. Press `Ctrl+Space` while off to enable and warm only. Wait for `ready` above the editor.
2. With Kitty key-release reporting, hold `Ctrl+Space` to record and release it to finalize. Without usable release reporting, short presses toggle recording on and off. Set `voice.mode` to `toggle` to always use successive presses.
3. Review the finalized text in the prompt. Voice never auto-submits. Enter and Alt+Enter keep their normal submission behavior. Submitting text or a non-Voice command retires active dictation so a late result cannot enter the next prompt. Voice control commands remain usable during recording.

`Ctrl+Alt+X` discards dictation only. It stops active capture or discards pending speech without changing the typed draft, Vim mode or the running Pi agent. Escape and Ctrl+C are untouched and retain their ordinary Vim/Pi behavior. They are not Voice cancel keys. Voice does not bind Option+Space, so Handy can keep that shortcut.

### Commands

| Command                                | Effect                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/voice`                               | Toggle enabled state. Enabling warms only, disabling stops and clears Voice.                               |
| `/voice on`                            | Enable and warm without microphone capture.                                                                |
| `/voice off`                           | Stop the worker and discard active or pending dictation.                                                   |
| `/voice start`                         | Start capture when ready at the main prompt. From off, only enable and warm, then invoke again once ready. |
| `/voice stop`                          | Stop capture and request the final whole-clip transcript.                                                  |
| `/voice cancel`                        | Discard dictation without changing the draft. Keep the model warm.                                         |
| `/voice insert`                        | Explicitly insert a pending final at the main prompt.                                                      |
| `/voice status`                        | Show the current state without starting capture.                                                           |
| `/voice space on` / `/voice space off` | Override hold-Space for this session, without enabling Voice or starting capture.                          |

## Previews and final insertion

Live previews appear in a widget above the editor, not in the draft. They are provisional full replacements. Earlier words can change as more audio arrives. The widget shows at most three wrapped preview lines.

The complete finalized transcript enters through Pi's native bracketed-paste path at the current cursor. It is one literal paste, not simulated typing or Vim commands. The bundled Vim editor preserves NORMAL or INSERT mode, and one undo removes the final paste.

If the draft text has changed since recording began, or a modal has focus when the final arrives, Voice holds the final as `pending` in RAM instead of inserting it. Return to the main prompt and press `Ctrl+Space` to explicitly insert it at the current cursor. That press does not start another recording. Use `Ctrl+Alt+X` to discard it. `/voice insert` and `/voice cancel` are the command equivalents. Disabling Voice, reloading or switching sessions discards pending text.

## Optional bare Space

Hold-Space is off by default. Enable it with `/voice space on` for the current session or `voice.space: true` in private configuration. The session override resets on reload or session replacement.

It requires Kitty key-release reporting, including reporting ordinary Space presses and releases. While Voice is ready at the main prompt, hold a literal Space for 300 ms to start capture and release to finalize. A shorter tap types one ordinary space through native editor input, not paste. Without release reporting, Space stays ordinary input.

In the bundled Vim editor this works only in INSERT, outside completion and character-jump prompts. NORMAL commands stay normal, including `f` followed by Space. Pi's stock editor is also supported. Other custom editors must explicitly expose an `acceptsLiteralSpace` boolean getter that returns true only where Space is literal text. Otherwise Voice leaves their Space input alone.

## Configuration and microphone device

Defaults in `~/.config/pi-extensions/config.json`:

```json
{
  "voice": {
    "shortcut": "ctrl+space",
    "cancelShortcut": "ctrl+alt+x",
    "mode": "hold",
    "space": false,
    "device": ":default"
  }
}
```

There is no persisted `enabled` setting. Every new or reloaded session starts off. `mode` accepts only `hold` or `toggle`. Recording accepts `ctrl+space` or a lowercase `ctrl+alt+letter` combination. Cancellation remains a lowercase `ctrl+alt+letter` combination. They must differ. Plain Option-letter bindings can type German-layout characters. macOS can reserve Ctrl+Space for switching input sources. Disable that system binding or select a supported alternative if it is active. Activation checks Pi's resolved keybindings, not operating-system or other application shortcuts. Apply configuration changes with `/reload`. After updating the extension's shared configuration code, restart Pi because its native JavaScript dependencies can remain cached across reloads.

`device` is an AVFoundation audio selector. `:default` uses the system default. An explicit index such as `:0` selects an audio device by number, not a video source. Voice never enumerates devices automatically.

Optional device listing is a user-triggered diagnostic and can itself request microphone permission. Run this only if you want to list your devices:

```sh
ffmpeg -f avfoundation -list_devices true -i ""
```

Choose an audio index from your own output. No hardware names or device-list output are needed in this repository. See [configuration](../../docs/configuration.md#local-voice) for the shared configuration rules.

## States, limits and cleanup

| Visible state              | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `off`                      | No Voice widget or worker after cleanup.                     |
| `loading` / `ready`        | Loading or keeping the model warm. No microphone capture.    |
| `starting` / `● recording` | Capture requested or in progress.                            |
| `finalizing`               | Capture stops and the final decode runs.                     |
| `pending`                  | No capture. Final text awaits explicit insertion or discard. |

Each recording has a hard 60-second limit. Model startup has a 60-second deadline. Microphone startup and finalization each have a 15-second deadline. The capture reader also stops after five seconds without audio. Timeout cleanup shuts down the worker process group, escalating to termination and kill if needed. A cleanup failure is reported. Restart Pi before retrying if it cannot stop the worker.

Suspending Pi or opening its external editor discards active dictation before handing over the terminal. Cleanup must finish before another worker can start. Escape remains unrelated to dictation cancellation.

The model stays warm until `/voice off`, reload, session replacement or exit, unless a worker error disables Voice first. There is one worker process group per enabled session, not a shared daemon. `ffmpeg` runs only for capture.

The worker redecodes the entire bounded clip after every two seconds of new audio, then makes a fresh whole-clip final pass. This is simpler than merging overlapping text, but inference work grows with clip length. Two seconds is an audio threshold, not a guaranteed preview interval. No latency or memory benchmark is claimed. See [performance](../../docs/performance.md#local-voice-costs).

## Privacy

Captured audio stays in RAM. Voice writes no audio files or transcript logs. Cancel stops capture and invalidates late output immediately. An in-flight MLX decode cannot be interrupted safely, so its input is released when that call returns. Worker teardown ends the process group.

Previews and pending finals stay in memory. Once inserted, text is an ordinary Pi draft. Submitting it uses Pi's normal provider and session-history behavior. Local speech recognition does not prevent submitted text from reaching a remote provider or being saved in Pi history.

## Verification

The implementation is exercised against Pi 1.5.2. Other Pi versions are not assumed compatible. The older Pi 1.5.0 extraction measurements do not verify Voice.

From the repository root:

```sh
node scripts/test.mjs tests/voice.test.mjs tests/voice-state.test.mjs tests/voice-pty.test.mjs
npm run test:python
npm run lint:check
```

These tests use synthetic data and fake capture/model adapters. They check gestures, native paste, pending finals and cleanup without opening the microphone or loading a speech model. PTY tests run the installed Pi in regular and fullscreen modes with a fake worker, including actual redraw and reload behavior. They do not verify real microphone capture or human speech accuracy.

An actual microphone and accuracy check needs an explicit manual test:

1. Choose to allow local microphone capture, enable Voice and wait for `ready`.
2. Record a synthetic phrase such as "This is a synthetic voice test." Stop and confirm that the microphone indicator clears, the final is accurate and nothing was submitted.
3. Record again while editing the draft. Confirm the final stays pending, then explicitly insert or discard it at the main prompt.
4. Run `/voice off` and confirm capture and the Voice widget are gone. Check hold/release behavior in the terminal you actually use, including optional Space only if you enable it.
