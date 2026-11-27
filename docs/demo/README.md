# README demos

Record one useful interaction, not a tour of every control.

1. **Agents:** all sessions → Needs you across projects → read two questions.
2. **Comms:** review a request → pick an agent → see the blank split → paste context manually.
3. **Voice:** record → preview → final unsent prompt → Vim undo and redo.

The root README keeps Agents and Comms above Install. Voice lives in its own extension README.

## Source and installation

The Comms handoff was recorded with Pi 1.6.1. Agents and Voice use Pi 1.5.2. Install the [verified source revision](../../README.md#install) to use the demonstrated features.

The `v0.1.0` GitHub release hosts the GIFs. Its source tag predates Voice and later Agents and Comms changes. No new source release or tag is required to update media.

## Render

Requires an installed compatible Pi, Node, VHS and ffmpeg. Agents and Comms also require tmux. The Comms split requires macOS. Install missing tools explicitly, not as a side effect of recording.

From the repository root:

```sh
vhs validate 'docs/demo/*.tape'
vhs docs/demo/agents.tape
vhs docs/demo/comms.tape
vhs docs/demo/voice.tape
```

Outputs are `/tmp/agents-demo.gif`, `/tmp/comms-handoff-demo.gif` and `/tmp/voice-demo.gif`. Keep binaries outside this public source tree. When iterating, copy the tape to a scratch directory and change only its `Output` line so reviewed renders are not overwritten.

`world.mjs` creates a fresh HOME, project folders, configuration, agent state, Claude/Codex state and a private tmux directory. All launchers use an explicit environment allowlist. Inherited credentials, remote settings, `TMUX` and `TMUX_PANE` do not reach Pi. Comms gets fresh tmux variables from its own attached window. A detached watchdog stops only the private tmux server and removes the world after five minutes. Startup stays hidden and the recording ends inside the demonstrated view.

Agents uses synthetic Claude metadata plus real idle Pi sessions. It never attaches to an agent or runs a model.

Comms uses `/comms` with a synthetic saved queue because the built-in `/comms demo` disables external actions, including handoff. `comms-world.mjs` starts an isolated, attached tmux window with fake executables for all three agent choices. The recording-only `comms.ts` seeds the queue and writes copied text to a private fixture file, not the system clipboard. The mock agent starts blank, then Ctrl+V explicitly shows an excerpt of that file without submitting anything. There are no live connector or model calls. Do not record the normal queue.

Voice loads `voice.ts`, a recording-only entrypoint that installs the shipped Voice controller and Vim editor with `voice-worker.mjs` instead of a microphone/model worker. A visible label identifies simulated speech throughout. Toggle mode avoids relying on terminal key-release support. Preview and final delays are scripted UI fixtures, not latency measurements. No speech accuracy claim follows from this GIF. A display-only provider fixture avoids Pi's missing-model startup warning, which can include its installation path. Text input is handled without starting a provider turn. The entrypoint is not registered in the installed package.

## Review the rendered files

Check the GIF itself, not only screenshots taken by the tape. Sample contact sheets help with pacing:

```sh
ffprobe -v error -show_entries format=duration,size -of json /tmp/agents-demo.gif
ffmpeg -loglevel error -y -i /tmp/agents-demo.gif \
  -vf 'fps=2,scale=600:-1,tile=4x12' -frames:v 1 /tmp/agents-sheet.png
```

Adjust the tile count or create multiple sheets to cover the whole animation. Sampling is not a complete frame review. Before upload, decode every frame, inspect the initial view and every changed region, and check all transitions. Look for real paths, names, hostnames, IDs, message text or views outside the synthetic world. The Voice simulation label must stay visible. Reject any render with private content.

Also confirm the story actually happens: Agents shows questions from different projects, Comms keeps the thread in the left pane and shows a blank mock agent until manual paste, and Voice inserts its final only after stop and leaves it unsent.

## Publish only after approval

Review each changed GIF separately from the source diff. Obtain explicit approval for the public upload. After approval, upload only the new or changed asset. For the first Comms handoff upload:

```sh
gh release upload v0.1.0 /tmp/comms-handoff-demo.gif
```

Verify the new public URL before publishing the README links. Leave the older Comms asset in place for previous revisions. Publish documentation changes only with separate authorization.
