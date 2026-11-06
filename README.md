# Pi extensions

Ten extensions for [Pi](https://github.com/earendil-works/pi). One package, with optional local integrations. Tested against Pi 1.5.0 and Node 26.8.1. Pi requires Node 22.19.0 or newer. Other Pi versions are not yet verified.

![Agents dashboard with Pi and Claude Code sessions across three projects, shown with demo data](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/agents-demo.gif)

`/agents`: Pi, Claude Code, Codex and tmux sessions in one view.

![Comms review queue with request details, actions and source coverage, shown with demo data](https://github.com/alexoberneyer/pi-extensions/releases/download/v0.1.0/comms-demo.gif)

`/comms demo`: requests, drafts and follow-ups in one review queue, with sample data.

## Install

Review the source before installing. Extensions run with your operating-system permissions. This package is not a sandbox.

From a local checkout:

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi install /absolute/path/to/pi-extensions
```

From GitHub:

```sh
pi install git:github.com/alexoberneyer/pi-extensions@v0.1.0
```

Run `/reload` in existing Pi sessions. Use `pi config` to select the extensions you want. Package filters can select individual entrypoints, for example:

```json
{
  "packages": [
    {
      "source": "/absolute/path/to/pi-extensions",
      "extensions": ["extensions/vim/index.ts", "extensions/web/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Do not load this package alongside older copies of the same extensions. See [migration](docs/migration.md) before replacing an existing installation.

## Included extensions

| Extension                                       | Purpose                                            | Default behavior                                 |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| [Vim](extensions/vim/README.md)                 | Vim motions, operators and undo/redo in the prompt | Interactive editor only                          |
| [Web](extensions/web/README.md)                 | Brave search and public-page extraction            | Tools available, no requests until called        |
| [Fast](extensions/fast/README.md)               | Supported-provider speed tiers                     | Off for new sessions                             |
| [Agents](extensions/agents/README.md)           | Pi, Claude, Codex and tmux dashboard               | Local Pi presence, discovery only while browsing |
| [dev01](extensions/dev01/README.md)             | Explicit remote jobs and file transfers            | Disabled without a configured SSH host           |
| [Approval](extensions/approval/README.md)       | Confirmation and plan-mode workflow guards         | Generic guards active                            |
| [Workflows](extensions/workflows/README.md)     | Plan mode, checklist, subagents and notification   | Plan mode off, bundled guard loaded              |
| [Supervisor](extensions/supervisor/README.md)   | Persistent, human-interruptible Pi workers         | Off until explicitly enabled                     |
| [Comms](extensions/comms/README.md)             | Communication review queue, drafts and captures    | Queue tools inactive until a user action         |
| [Workstation](extensions/workstation/README.md) | Private memory, style, resources and hooks         | All private integrations off                     |

`workflows`, `supervisor` and `comms` initialize the bundled approval guard even when installed individually. Registration is deduplicated within the extension runtime. Unknown/broken guard configuration blocks tools rather than silently weakening protection.

## Private configuration

Copy [the example](examples/config.example.json) to `~/.config/pi-extensions/config.json`. Keep your edited copy outside this repository. Restrict its directory to `0700` and file to `0600`.

`XDG_CONFIG_HOME` changes the default directory. `PI_EXTENSIONS_CONFIG=/absolute/path/config.json` selects one explicit file. No project-directory configuration is discovered. Relative local paths inside the file resolve against its directory. Remote paths stay remote.

A missing default file uses safe defaults. An explicitly selected missing file, malformed JSON, unknown settings or invalid values are errors. No credentials belong in this file. Configure provider and connector authentication in the owning application.

See [configuration](docs/configuration.md) for optional integrations and [performance](docs/performance.md) for costs and compatibility tradeoffs.

## Requirements and limits

1. **Pi:** all extensions use its runtime packages as peers. Do not install another copy of Pi inside this package.
2. **External agents:** install and authenticate the CLIs you actually use. Codex discovery needs an existing compatible local app-server. It does not start one.
3. **Remote work:** SSH, Bash, tmux and the selected agent must already work on the configured host. Transfers require rsync with `--protect-args`.
4. **Desktop sources:** Apple Reminders needs macOS Automation permission. reMarkable uses a configured desktop copy and optional Python dependencies. Unsupported desktop features stay unavailable on other systems.
5. **Web and Comms:** Brave needs your own key. Web extraction uses `uvx`. Comms uses your existing Claude or Pi connectors, not shared credentials or an included Microsoft 365 connection.

Use scoped credentials and actual isolation for untrusted or unattended work. Approval patterns, tool annotations, project trust and task scopes do not restrict operating-system access. Worker processes inherit much of the environment and share their selected working directory.

## Develop

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run test:python
npm run lint:check
npm run check:release
```

Re-render the demo GIFs with [VHS](https://github.com/charmbracelet/vhs): run `vhs docs/demo/agents.tape` or `vhs docs/demo/comms.tape` from the repository root. They write to `/tmp` and use throwaway directories and sample data only. Review every frame, then replace the release assets with `gh release upload v0.1.0 /tmp/agents-demo.gif /tmp/comms-demo.gif --clobber`.

The Node test runner uses a fresh HOME, explicit environment and temporary state. It selects the installed Pi package automatically, or accepts `PI_TEST_PACKAGE_DIR`. Tests use fixture agents, local sockets and intercepted HTTP requests. They do not call a model or read your real queue, notebooks or credentials.

The standard-library Python tests skip codec fixtures when optional dependencies are missing. See [verification](docs/verification.md) for the full codec suite and release checks.

## License

MIT. See [LICENSE](LICENSE) and [dependency notes](NOTICE.md).
