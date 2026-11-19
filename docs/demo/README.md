# README demos

Record one useful interaction, not a tour of every control.

1. **Agents:** all sessions → Needs you across projects → read two questions.
2. **Comms:** review an unsent draft → dismiss its request → undo → restored draft.
3. **Voice:** record → preview → final unsent prompt → Vim undo and redo.

The root README keeps Agents and Comms above Install. Voice lives in its own extension README.

## Source and installation

The demonstrated runtime behavior is available at public source revision [`79cbc33`](https://github.com/alexoberneyer/pi-extensions/commit/79cbc336c8f0f131dcd70aee03b1204cae02d279). The root installation command pins that complete commit. These recordings use Pi 1.5.2.

The `v0.1.0` GitHub release is the existing media host only. Its source tag predates Voice and later Agents and Comms changes. Hosting a GIF there does not make that source tag the demonstrated version. No new source release or tag is required to update media.

## Render

Requires an installed compatible Pi, Node, VHS and ffmpeg. Agents also requires tmux. Install missing tools explicitly, not as a side effect of recording.

From the repository root:

```sh
vhs validate 'docs/demo/*.tape'
vhs docs/demo/agents.tape
vhs docs/demo/comms.tape
vhs docs/demo/voice.tape
```

Outputs are `/tmp/agents-demo.gif`, `/tmp/comms-demo.gif` and `/tmp/voice-demo.gif`. Keep binaries outside this public source tree. When iterating, copy the tape to a scratch directory and change only its `Output` line so reviewed renders are not overwritten.

`world.mjs` creates a fresh HOME, project folders, configuration, agent state, Claude/Codex state and a private tmux directory. Its launcher uses `env -i` and an explicit allowlist. Inherited credentials, remote settings, `TMUX` and `TMUX_PANE` do not reach Pi. A detached watchdog stops only the private tmux server and removes the world after five minutes. Startup stays hidden and the recording ends inside the demonstrated view.

Agents uses synthetic Claude metadata plus real idle Pi sessions. It never attaches to an agent or runs a model. Comms uses `/comms demo`, whose decisions are memory-only. It cannot open live sources, collect messages or write Reminders. The recording dismisses and restores a request rather than pretending to create a reminder.

Voice loads `voice.ts`, a recording-only entrypoint that installs the shipped Voice controller and Vim editor with `voice-worker.mjs` instead of a microphone/model worker. A visible label identifies simulated speech throughout. Toggle mode avoids relying on terminal key-release support. Preview and final delays are scripted UI fixtures, not latency measurements. No speech accuracy claim follows from this GIF. A display-only provider fixture avoids Pi's missing-model startup warning, which can include its installation path. Text input is handled without starting a provider turn. The entrypoint is not registered in the installed package.

## Review the rendered files

Check the GIF itself, not only screenshots taken by the tape. Sample contact sheets help with pacing:

```sh
ffprobe -v error -show_entries format=duration,size -of json /tmp/agents-demo.gif
ffmpeg -loglevel error -y -i /tmp/agents-demo.gif \
  -vf 'fps=2,scale=600:-1,tile=4x12' -frames:v 1 /tmp/agents-sheet.png
```

Adjust the tile count or create multiple sheets to cover the whole animation. Sampling is not a complete frame review. Before upload, decode every frame, inspect the initial view and every changed region, and check all transitions. Look for real paths, names, hostnames, IDs, message text or views outside the synthetic world. The Voice simulation label must stay visible. Reject any render with private content.

Also confirm the story actually happens: Agents shows questions from different projects, Comms visibly removes and restores the same request, and Voice inserts its final only after stop and leaves it unsent.

## Publish only after approval

Review all three rendered GIFs separately from the source diff. Obtain explicit approval for the public upload. After approval, from the repository root:

```sh
gh release upload v0.1.0 \
  /tmp/agents-demo.gif /tmp/comms-demo.gif /tmp/voice-demo.gif --clobber
```

This replaces the two existing assets and adds Voice. Verify all README image URLs after upload. Publish the documentation changes only with separate authorization. The new Voice image link will not resolve publicly until its asset has been uploaded.
