# Local voice dictation

Dictate into Pi's main prompt on macOS arm64, outside SSH. Voice starts off unless you previously enabled it. Saved-on sessions restore in `standby` with no model worker or microphone. `/voice on` saves the preference and warms the current window without capture. Recording always needs an explicit gesture or `/voice start`.

No text-to-speech, always-listening mode or remote capture. Local speech recognition does not make the rest of Pi local.

## Interaction demo

![Voice UI with labelled simulated speech: record, preview, insert an unsent prompt, undo and redo](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/voice-demo.gif)

Record → preview → final text in the prompt. One Vim undo removes the paste, redo restores it. Nothing is submitted.

This is the real Voice controller and editor with a simulated worker. No microphone or speech model runs. The animation does not demonstrate recognition accuracy, model startup time or transcription latency. [Recording source and reproduction](../../docs/demo/README.md).

## One-time setup

1. Install `ffmpeg` and `uv` separately and make them available on `PATH`. They are optional system dependencies, not bundled npm dependencies. Use a local interactive terminal on an Apple silicon Mac.
2. Explicitly cache Python 3.10, `mlx-audio==0.5.3` and the Parakeet model:

   ```sh
   uv run --no-project --python 3.10 --with mlx-audio==0.5.3 python -c 'from mlx_audio.stt import load; load("mlx-community/parakeet-tdt-0.6b-v3")'
   ```

   This setup command downloads dependencies and the model as needed and populates their caches. It does not install `ffmpeg`. Review its network and disk use before running it.

3. Load Voice through the package's `pi config` selection. Fully restart Pi after updating this implementation. `/reload` alone cannot replace native JavaScript modules retained in its module cache. To try the source checkout without installing it, run `pi -e ./extensions/voice/index.ts` from the repository root. Do not load both copies.
4. Run `/voice on` once at the main prompt after restarting and wait for `ready`. This saves your enabled preference for future sessions. On the first explicit recording, grant microphone permission to the terminal application in macOS System Settings → Privacy & Security → Microphone. Do not bypass macOS privacy controls.

Runtime startup forces `uv run --offline` and `HF_HUB_OFFLINE=1`. `/voice` does not download models or use the network. Missing Python, dependency or model caches cause an error instead. Keep the setup and runtime cache locations consistent.

## Record and review

1. Press `Ctrl+Space` while off to enable, save the preference and warm only. That first press never captures. Wait for `ready` above the editor.
2. With Kitty key-release reporting, hold `Ctrl+Space` and wait for `● recording` before talking. Release to finalize. From `standby`, the gesture first loads the model and queues capture only while still requested. Releasing before it is ready cancels capture intent. Without usable release reporting, short presses toggle recording on and off. Set `voice.mode` to `toggle` to always use successive presses. A second toggle press cancels queued capture during loading. The loading hint says to wait before speaking.
3. Review the finalized text in the prompt. Voice never auto-submits. Enter and Alt+Enter keep their normal submission behavior. Submitting text or a non-Voice command retires active dictation so a late result cannot enter the next prompt. Voice control commands remain usable during recording.

`Ctrl+C` discards active or pending dictation, including queued capture during loading. It still reaches Pi's native editor-clear and double-press-exit handling, so it can clear your typed draft too. Escape is unchanged and does not cancel Voice. `/voice cancel` discards only dictation without changing the draft. There is no dedicated discard shortcut or widget hint. Voice does not bind Option+Space, so Handy can keep that shortcut.

### Commands

| Command                                | Effect                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/voice`                               | Toggle and save enabled state. Enabling warms only, disabling stops and clears Voice.                |
| `/voice on`                            | Save enabled and warm the current window without microphone capture.                                 |
| `/voice off`                           | Save disabled, stop the worker and discard active or pending dictation.                              |
| `/voice start`                         | Request capture at the main prompt, loading first if needed. From off, only enable, save and warm.   |
| `/voice stop`                          | Cancel queued capture, or stop capture and request the final whole-clip transcript.                  |
| `/voice cancel`                        | Discard dictation without changing the draft or enabled preference. Do not reload an unloaded model. |
| `/voice insert`                        | Explicitly insert a pending final at the main prompt without loading the model.                      |
| `/voice status`                        | Show the current state and the input for the next recording without starting capture.                |
| `/voice space on` / `/voice space off` | Override hold-Space for this session, without enabling Voice or starting capture.                    |

## Previews and final insertion

Live previews appear in a widget above the editor, not in the draft. They are provisional full replacements. Earlier words can change as more audio arrives. The widget shows at most three wrapped preview lines.

The complete finalized transcript enters through Pi's native bracketed-paste path at the current cursor. It is one literal paste, not simulated typing or Vim commands. By default the bundled Vim editor preserves NORMAL or INSERT mode, and the paste uses the editor's normal undo behavior.

Set `voice.normalAfterInsert` to `true` to switch the Vim prompt to NORMAL after the final text is inserted. This also applies when you explicitly insert a pending transcript. Ordinary pastes and the stock editor are unchanged. To dictate again from NORMAL, use the recording shortcut or press `i` before using bare hold-Space.

If the draft text has changed since recording began, or a modal has focus when the final arrives, Voice holds the final as `pending` in RAM instead of inserting it. Return to the main prompt and press `Ctrl+Space` to explicitly insert it at the current cursor. That press does not start another recording or load an unloaded model. `/voice insert` does the same. Use `/voice cancel` to discard only speech, or `Ctrl+C` to discard speech with Pi's normal editor-clear behavior. Disabling Voice, reloading or switching sessions discards pending text.

## Optional bare Space

Hold-Space is off by default. Enable it with `/voice space on` for the current session or `voice.space: true` in private configuration. The session override resets on reload or session replacement.

It requires Kitty key-release reporting, including reporting ordinary Space presses and releases. While Voice is enabled and idle at the main prompt, hold a literal Space for 300 ms to request capture and release to finalize. From `standby`, keep holding and wait for `● recording` before talking. Releasing during loading cancels capture intent. A shorter tap types one ordinary space through native editor input, not paste. Without release reporting, Space stays ordinary input.

In the bundled Vim editor this works only in INSERT, outside completion and character-jump prompts. NORMAL commands stay normal, including `f` followed by Space. Pi's stock editor is also supported. Other custom editors must explicitly expose an `acceptsLiteralSpace` boolean getter that returns true only where Space is literal text. Otherwise Voice leaves their Space input alone.

## Configuration and microphone device

Defaults in `~/.config/pi-extensions/config.json`:

```json
{
  "voice": {
    "shortcut": "ctrl+space",
    "mode": "hold",
    "space": false,
    "normalAfterInsert": false,
    "device": ":default"
  }
}
```

`mode` accepts only `hold` or `toggle`. Recording accepts `ctrl+space` or a lowercase `ctrl+alt+letter` combination. The legacy `voice.cancelShortcut` key is accepted but ignored. Plain Option-letter bindings can type German-layout characters. macOS can reserve Ctrl+Space for switching input sources. Disable that system binding or select a supported alternative if it is active. Activation checks Pi's resolved keybindings, not operating-system or other application shortcuts. Apply configuration changes with `/reload`. Updating this implementation requires a full Pi restart because native JavaScript modules remain cached across reloads.

### Saved enabled preference

Only the enabled boolean is persisted, with schema-version metadata, in private `voice-state.json` beside the selected configuration file. The default is `~/.config/pi-extensions/voice-state.json`. `XDG_CONFIG_HOME` relocates the default directory. `PI_EXTENSIONS_CONFIG` places state in the selected file's parent directory. If that configuration is itself named `voice-state.json`, the preference uses `voice-preferences.json`. Configuration aliases are rejected rather than overwritten. New state files use `0600` permissions and newly created parent directories use `0700`. Installation writes no enabled preset or state file.

`/voice on` saves true and warms this window. `/voice off` saves false and stops it. The recording shortcut while off also saves true and warms without capture. Missing state means off. Unreadable or invalid state reports an error and leaves Voice off.

At `session_start`, new, resumed, forked and reloaded sessions, new windows and Pi restarts read the latest saved preference. Saved-on restores `standby` without starting a model worker or microphone. Already-open windows are not live-synced. Session cleanup, worker errors and idle unload never erase the preference. No workers start in headless, RPC, SSH or unsupported environments.

### Microphone device

`device` is an AVFoundation audio selector. `:default` uses the system default. An explicit index such as `:0` selects an audio device by number, not a video source. Indices can change when devices connect or disconnect.

`/voice status` looks up the input name on demand, even when Voice is off. It shows the input that a new recording would open now, not the route of an in-progress clip. The lookup does not open the microphone or start the model. If it cannot resolve the name, status shows `unavailable` and the configured selection.

Optional device listing is a user-triggered diagnostic and can itself request microphone permission. Run this only if you want to list your devices:

```sh
ffmpeg -f avfoundation -list_devices true -i ""
```

Choose an audio index from your own output. No hardware names or device-list output are needed in this repository. See [configuration](../../docs/configuration.md#local-voice) for the shared configuration rules.

## States, limits and cleanup

| Visible state              | Meaning                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `off`                      | No Voice widget or worker after cleanup.                       |
| `standby`                  | Enabled with no model worker or microphone.                    |
| `loading` / `ready`        | Loading or keeping the model warm. No microphone capture yet.  |
| `starting` / `● recording` | Capture requested or in progress.                              |
| `finalizing`               | Capture stops and the final decode runs.                       |
| `pending`                  | Final text awaits insertion or discard. Model may be unloaded. |

Each recording has a hard 60-second limit. The Voice widget counts down the last 10 seconds, then capture stops and the clip finalizes automatically. Model startup has a 60-second deadline. Microphone startup and finalization each have a 15-second deadline. The capture reader also stops after five seconds without audio. Timeout cleanup shuts down the worker process group, escalating to termination and kill if needed. A cleanup failure blocks replacement workers across reloads. Restart Pi before retrying if it cannot stop the worker.

Suspending Pi or opening its external editor discards active dictation before handing over the terminal. Cleanup must finish before another worker can start. Escape remains unrelated to dictation cancellation.

After five idle minutes in `ready` or `pending`, Voice unloads the entire model worker. Ordinary typed prompts and editor clearing do not extend the Voice idle deadline. Voice stays enabled in `standby`, or keeps a pending final in RAM without the model. Inserting or cancelling that final does not reload it. Loading, recording and finalizing do not idle-unload. The next recording gesture cold-loads and captures only if the request is still active and the main prompt has focus. Never speak until `● recording` appears.

There is one worker process group per actively used window, not a shared server. Restored standby windows have none. `/voice off`, reload, session replacement and exit also stop the worker. Errors can turn Voice off in the current window without changing the saved preference. `ffmpeg` runs only for capture.

The worker redecodes the entire bounded clip after every two seconds of new audio, then makes a fresh whole-clip final pass. This is simpler than merging overlapping text, but inference work grows with clip length. Two seconds is an audio threshold, not a guaranteed preview interval. See [performance](../../docs/performance.md#local-voice-costs) for bounded local cost measurements, not hardware or latency guarantees.

## Privacy

Captured audio stays in RAM. Voice writes no audio files or transcript logs. Cancel stops capture and invalidates late output immediately. An in-flight MLX decode cannot be interrupted safely, so its input is released when that call returns. Worker teardown ends the process group.

Previews and pending finals stay in memory. The private preference file stores no audio, transcript, pending text or session data. Once inserted, text is an ordinary Pi draft. Submitting it uses Pi's normal provider and session-history behavior. Local speech recognition does not prevent submitted text from reaching a remote provider or being saved in Pi history.

## Verification

The implementation is exercised against Pi 1.6.1. Other Pi versions are not assumed compatible. The older Pi 1.5.0 extraction measurements do not verify Voice.

From the repository root:

```sh
node scripts/test.mjs tests/voice.test.mjs tests/voice-state.test.mjs tests/voice-preferences.test.mjs tests/voice-pty.test.mjs
npm run test:python
npm run lint:check
```

These automated tests use synthetic data and fake capture/model adapters. They cover private preferences, idle unload, gestures, native paste, pending finals and cleanup without opening the microphone or loading a speech model. PTY tests run the installed Pi in regular and fullscreen modes with a fake worker, including actual redraw and reload behavior. They do not verify real microphone capture or human speech accuracy.

A separate local review used the cached model and synthetic audio, not the microphone. It is not part of the model-free automated suite. See [verification](../../docs/verification.md#local-voice-verification) for that boundary and the standby lifecycle checklist.

An actual microphone and accuracy check needs an explicit manual test:

1. Run `/voice status` to check the input. With `:default`, change the input in macOS Sound settings and run it again to confirm the name updates. Then choose to allow local microphone capture, enable Voice and wait for `ready`.
2. Record a synthetic phrase such as "This is a synthetic voice test." Stop and confirm that the microphone indicator clears, the final is accurate and nothing was submitted.
3. Record again while editing the draft. Confirm the final stays pending, then explicitly insert or discard it at the main prompt.
4. Run `/voice off` and confirm capture and the Voice widget are gone. Check hold/release behavior in the terminal you actually use, including optional Space only if you enable it.
