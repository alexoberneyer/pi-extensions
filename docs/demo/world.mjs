// Throwaway state and an allowlisted child environment for README recordings.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function createWorld(name) {
  if (!["agents", "comms", "voice"].includes(name))
    throw new Error("Choose agents, comms or voice.");
  // Short, canonical paths also leave room for macOS tmux socket names.
  const root = realpathSync(
    mkdtempSync(
      join(
        process.platform === "darwin" ? "/tmp" : tmpdir(),
        `pi-demo-${name}-`,
      ),
    ),
  );
  const home = join(root, "home");
  const project = (value) => join(home, "projects", value);
  const env = {
    HOME: home,
    PATH: `${join(root, "bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_EXTENSIONS_CONFIG: join(root, "config", "config.json"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    TMUX_TMPDIR: join(root, "tmux"),
    PI_AGENTS_EXTERNAL: name === "agents" ? "1" : "0",
    PI_AGENTS_DEV01: "0",
    PI_NOTIFY: "0",
    PI_QMD_REFRESH: "0",
  };
  for (const dir of [
    home,
    project("shop-api"),
    project("docs-site"),
    project("infra"),
    ...["bin", "tmp", "pi", "config", "cache", "claude", "codex", "tmux"].map(
      (part) => join(root, part),
    ),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    env.PI_EXTENSIONS_CONFIG,
    JSON.stringify(name === "voice" ? { voice: { mode: "toggle" } } : {}),
    { mode: 0o600 },
  );
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "settings.json"),
    JSON.stringify({ quietStartup: true }),
    { mode: 0o600 },
  );
  const launcher = join(root, "bin", "pi-demo");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec env -i ${Object.entries(env)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ")} pi "$@"\n`,
    { mode: 0o700 },
  );
  return { root, home, project, env, launcher };
}

export function startWatchdog(world) {
  // env excludes inherited TMUX/TMUX_PANE, credentials and private overrides.
  const processHandle = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
setTimeout(() => {
  try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch {}
  rmSync(${JSON.stringify(world.root)}, { recursive: true, force: true });
}, 300000);`,
    ],
    { env: world.env, detached: true, stdio: "ignore" },
  );
  processHandle.unref();
  return processHandle;
}

export function shellExports(world, extra = {}) {
  return [
    ...Object.entries({
      ...world.env,
      PI_DEMO_LAUNCHER: world.launcher,
      ...extra,
    }).map(([key, value]) => `export ${key}=${quote(value)}`),
    "unset TMUX TMUX_PANE",
    `cd ${quote(world.project("shop-api"))}`,
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const name = process.argv[2];
  const world = createWorld(name);
  startWatchdog(world);
  const extension = fileURLToPath(
    name === "voice"
      ? new URL("./voice.ts", import.meta.url)
      : new URL(`../../extensions/${name}/index.ts`, import.meta.url),
  );
  console.log(shellExports(world, { PI_DEMO_EXTENSION: extension }));
}
