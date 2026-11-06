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

## Optional Python codec fixtures

The default Python suite runs without installing packages. Some reMarkable decoding/rendering tests skip unless `rmscene` and Pillow are installed.

For full synthetic codec coverage, use an isolated uv environment:

```sh
uv run --no-project --with rmscene==0.6.1 --with pillow node scripts/test.mjs --python
```

Dependency acquisition requires network access on first use. Notebook fixtures are generated in temporary directories. No desktop copy or tablet is required. Python 3.10 or newer is required.

## Release gate

`npm run check:release` checks the working tree's public-file allowlist, obvious embedded secrets, private source paths and Markdown punctuation. It excludes ignored dependency/cache directories. It also verifies the npm package contents through a script-free dry run. This is a release guard, not proof that no secret or legal issue exists.

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
