# Migration from existing copies

Keep the working installation until the standalone package passes its checks. This repository does not modify live Pi settings, existing symlinks or private state automatically.

## Prepare

1. Install the package's dependencies with `npm ci --ignore-scripts --legacy-peer-deps`.
2. Create private configuration from `examples/config.example.json`. Restore your identity, timezone and optional integration paths there, not in public source.
3. Run `npm test`, `npm run test:python`, `npm run lint:check` and `npm run check:release`.

Existing users may need to configure the remote SSH host/project/shared directory, default Fast tier, additional protected CLI names, private workflow files and workstation hooks. Package agent definitions live under `agents/`. Existing user definitions remain untouched. The upstream subagent example reads Pi's user/project agent directories. Install definitions there deliberately if you need them, preserving any conflicting files.

## Switch once approved

1. Close sessions that own supervisor workers. Do not detach a running worker and then replace its supervisor code.
2. Back up or move only the old links for these ten extensions. Do not remove the whole Pi extensions directory, which may contain unrelated work.
3. Add this checkout with `pi install /absolute/path/to/pi-extensions`. Restart Pi or reload each remaining open session after the old copies are no longer discovered.

Use either package installation or your own symlink declarations, not both. Keep private prompt aliases and skill references in private configuration.

After verification, update the private dotfiles installer to reference this repository and retire its duplicate source. That is a separate change to the owning repository. Do not delete the old source before the rollback path is tested.

## State compatibility

Existing storage roots and identifiers are intentionally retained:

- Pi presence under `<agent directory>/agents-status/`.
- Approval decisions under `<agent directory>/approval-log/`.
- Comms queue, local drafts and capture evidence under `<agent directory>/comms/`.
- Supervisor metadata and worker conversations under `<agent directory>/supervisor/`.
- Session entries named `astra-fast`, `dotfiles-workflows` and `dotfiles-approval`.

No queue, credential or conversation migration is required. Old saved speed-tier choices still restore. New sessions use the configured default, which is off unless changed.

The standalone reMarkable helper's legacy text/filing cache is now under `$XDG_CACHE_HOME/pi-extensions/remarkable`, defaulting to `~/.cache/pi-extensions/remarkable`. It never writes cache data beside installed source. Existing scratchpad capture storage is unchanged. Legacy caches are not copied automatically.

## Roll back

Remove only this package declaration, restore the saved old links and restart Pi. Private runtime state stays in place. Do not resume the same owned session in two processes. Do not delete queues or worker transcripts to troubleshoot package discovery.
