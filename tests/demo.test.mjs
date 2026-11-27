import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createCommsWorld } from "../docs/demo/comms-world.mjs";
import { createWorld, quote, shellExports } from "../docs/demo/world.mjs";
import { createDemoWorker, transcript } from "../docs/demo/voice-worker.mjs";

for (const name of ["agents", "comms", "voice"]) {
  test(`${name} demo uses private throwaway state and an allowlisted launcher`, (t) => {
    const world = createWorld(name);
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    for (const key of [
      "HOME",
      "PI_CODING_AGENT_DIR",
      "PI_EXTENSIONS_CONFIG",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "TMUX_TMPDIR",
    ])
      assert.ok(world.env[key].startsWith(`${world.root}/`), key);
    for (const key of [
      "TMUX",
      "TMUX_PANE",
      "SSH_CONNECTION",
      "ANTHROPIC_API_KEY",
    ])
      assert.equal(world.env[key], undefined, key);
    assert.equal(world.env.PI_AGENTS_DEV01, "0");
    assert.equal(world.env.PI_AGENTS_EXTERNAL, name === "agents" ? "1" : "0");
    assert.equal(statSync(world.root).mode & 0o777, 0o700);
    assert.equal(statSync(world.env.PI_EXTENSIONS_CONFIG).mode & 0o777, 0o600);
    const config = JSON.parse(
      readFileSync(world.env.PI_EXTENSIONS_CONFIG, "utf8"),
    );
    assert.deepEqual(
      config,
      name === "voice" ? { voice: { mode: "toggle" } } : {},
    );
    const launcher = readFileSync(world.launcher, "utf8");
    assert.match(launcher, /exec env -i /);
    const exported = shellExports(world);
    assert.match(exported, /unset TMUX TMUX_PANE/);
    execFileSync("sh", ["-n"], { input: `${exported}\n${launcher}` });
    assert.equal(
      execFileSync("sh", ["-c", `printf %s ${quote("a'b c")}`], {
        encoding: "utf8",
      }),
      "a'b c",
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(world.env.PI_CODING_AGENT_DIR, "settings.json"),
          "utf8",
        ),
      ),
      { quietStartup: true },
    );
  });
}

test("Comms recording uses mock agent commands and blocks desktop helpers", (t) => {
  const world = createCommsWorld();
  t.after(() => rmSync(world.root, { recursive: true, force: true }));
  const env = world.env;
  assert.equal(env.PI_DEMO_COMMS_ROOT, world.root);
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  for (const agent of ["claude", "pi", "codex"]) {
    const executable = join(world.root, "bin", agent);
    assert.match(readFileSync(executable, "utf8"), /comms-agent\.mjs/);
    assert.throws(
      () => execFileSync(executable, ["prompt"], { env, stdio: "pipe" }),
      { status: 1 },
    );
  }
  for (const command of ["open", "osascript", "uv", "pbcopy", "pbpaste"])
    assert.throws(() => execFileSync(command, [], { env, stdio: "pipe" }), {
      status: 1,
    });
});

test("Voice demo emits previews and a final only after explicit stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const worker = createDemoWorker({ onEvent: (event) => events.push(event) });
  t.mock.timers.tick(200);
  assert.deepEqual(events, [{ type: "ready" }]);
  worker.send({ type: "start", id: 1 });
  t.mock.timers.tick(3000);
  assert.deepEqual(events.slice(1), [
    { type: "recording", id: 1 },
    { type: "partial", id: 1, text: "Add a retry limit" },
    { type: "partial", id: 1, text: transcript },
  ]);
  worker.send({ type: "stop", id: 1 });
  t.mock.timers.tick(800);
  assert.deepEqual(events.at(-1), { type: "final", id: 1, text: transcript });
  await worker.close();
});

test("Voice demo cancel and close invalidate delayed output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const worker = createDemoWorker({ onEvent: (event) => events.push(event) });
  t.mock.timers.tick(200);
  worker.send({ type: "start", id: 1 });
  worker.send({ type: "cancel", id: 1 });
  t.mock.timers.tick(5000);
  assert.deepEqual(events, [{ type: "ready" }, { type: "recording", id: 1 }]);
  worker.send({ type: "start", id: 2 });
  worker.send({ type: "stop", id: 2 });
  await worker.close();
  const count = events.length;
  t.mock.timers.tick(5000);
  assert.equal(events.length, count);
  assert.equal(worker.send({ type: "start", id: 3 }), false);
});
