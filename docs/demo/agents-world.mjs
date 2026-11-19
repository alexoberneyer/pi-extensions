// Synthetic Claude metadata and real idle Pi sessions on a private tmux server.
//   eval "$(node docs/demo/agents-world.mjs)"
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld, quote, shellExports, startWatchdog } from "./world.mjs";

const extension = fileURLToPath(
  new URL("../../extensions/agents/index.ts", import.meta.url),
);
const world = createWorld("agents");
const { root, project, env } = world;
// The cleanup watchdog is also the live PID in synthetic Claude metadata.
const watchdog = startWatchdog(world);

const now = Date.now();
const claude = [
  {
    cwd: project("shop-api"),
    status: "waiting",
    minutes: 1,
    waitingFor: "Should retries stop after three attempts or five?",
    prompt: "Add a retry limit to the webhook handler",
    reply:
      "Retry handling is implemented. Choose the maximum attempts before I add tests.",
  },
  {
    cwd: project("infra"),
    status: "waiting",
    minutes: 3,
    waitingFor: "Keep Node 24 for compatibility or move CI to Node 26?",
    prompt: "Choose the CI runner image",
    reply: "Both runner images build. Which version should CI use?",
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
    { env, stdio: "ignore" },
  );
pi("checkout", project("shop-api"), "Fix the flaky checkout test");
pi("node", project("infra"), "Upgrade the build image to Node 26");

console.log(shellExports(world, { PI_DEMO_EXTENSION: extension }));
