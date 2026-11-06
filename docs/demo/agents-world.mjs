// Builds a throwaway world for docs/demo/agents.tape and prints shell exports
// for it: a fake HOME, a fake `claude` that lists demo sessions with
// transcripts, and two named Pi sessions on a private tmux server. Nothing
// outside the new temporary directory is read or written. A watchdog stops
// the tmux server and removes the directory after a few minutes.
//
//   eval "$(node docs/demo/agents-world.mjs)"
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(
  new URL("../../extensions/agents/index.ts", import.meta.url),
);
// Resolve symlinks such as macOS /var so project paths display under ~.
const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-demo-")));
const home = join(root, "home");
const project = (name) => join(home, "projects", name);
const env = {
  HOME: home,
  PATH: `${join(root, "bin")}:${process.env.PATH}`,
  PI_CODING_AGENT_DIR: join(root, "pi"),
  XDG_CONFIG_HOME: join(root, "config"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"),
  TMUX_TMPDIR: join(root, "tmux"),
};
for (const dir of [
  project("shop-api"),
  project("docs-site"),
  project("infra"),
  join(root, "bin"),
  env.PI_CODING_AGENT_DIR,
  env.XDG_CONFIG_HOME,
  env.TMUX_TMPDIR,
])
  mkdirSync(dir, { recursive: true });
writeFileSync(
  join(env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ quietStartup: true }),
);

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
// A recording started inside tmux would otherwise point Pi at the real server.
const childEnv = { ...process.env, ...env };
delete childEnv.TMUX;
delete childEnv.TMUX_PANE;
// The watchdog doubles as the live process the fake Claude sessions report.
const watchdog = spawn(
  "sh",
  ["-c", `sleep 300; tmux kill-server; rm -rf ${quote(root)}`],
  { env: childEnv, detached: true, stdio: "ignore" },
);
watchdog.unref();

const now = Date.now();
const claude = [
  {
    cwd: project("shop-api"),
    status: "waiting",
    minutes: 1,
    waitingFor: "Permission: run the staging database migration?",
    prompt: "Add a retry with backoff to the payment webhook handler",
    reply: "The retry is in place. The migration adds an attempts column.",
  },
  {
    cwd: project("docs-site"),
    status: "busy",
    minutes: 0,
    prompt: "Update the API reference for the v2 endpoints",
    reply:
      "Nine of fourteen endpoint pages are updated. Checking examples now.",
  },
  {
    cwd: project("shop-api"),
    status: "idle",
    minutes: 25,
    prompt: "Write tests for the cart discount rules",
    reply: "Added 12 tests. All pass, and discount coverage is now 96%.",
  },
].map((session) => ({ ...session, sessionId: randomUUID() }));

for (const session of claude) {
  const folder = join(
    env.CLAUDE_CONFIG_DIR,
    "projects",
    session.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(folder, { recursive: true });
  const line = (role, content) =>
    JSON.stringify({
      type: role,
      sessionId: session.sessionId,
      cwd: session.cwd,
      message: { role, content },
    });
  writeFileSync(
    join(folder, `${session.sessionId}.jsonl`),
    `${line("user", session.prompt)}\n${line("assistant", session.reply)}\n`,
  );
}
writeFileSync(
  join(root, "claude-agents.json"),
  JSON.stringify(
    claude.map(({ sessionId, cwd, status, minutes, waitingFor }) => ({
      sessionId,
      cwd,
      status,
      waitingFor,
      pid: watchdog.pid,
      statusUpdatedAt: now - minutes * 60_000,
    })),
  ),
);
const fakeClaude = join(root, "bin", "claude");
writeFileSync(
  fakeClaude,
  `#!/bin/sh\n[ "$1 $2" = "agents --json" ] || exit 1\ncat '${join(root, "claude-agents.json")}'\n`,
);
chmodSync(fakeClaude, 0o755);

const pi = (session, cwd, name) =>
  execFileSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      cwd,
      "-x",
      "160",
      "-y",
      "40",
      `pi -ne -ns -nc -np --no-themes --no-mcp --offline -e ${quote(extension)} --name ${quote(name)}`,
    ],
    { env: childEnv, stdio: "ignore" },
  );
pi("checkout", project("shop-api"), "Fix the flaky checkout test");
pi("node", project("infra"), "Upgrade the build image to Node 26");

const exports = { ...env, AGENTS_DEMO_EXTENSION: extension };
console.log(
  Object.entries(exports)
    .map(([key, value]) => `export ${key}=${quote(value)}`)
    .join("\n"),
);
console.log("unset TMUX TMUX_PANE");
console.log(`cd ${quote(project("shop-api"))}`);
