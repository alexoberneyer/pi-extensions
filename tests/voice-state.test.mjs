import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchWorker } from "../extensions/voice/client.mjs";
import { VoiceController } from "../extensions/voice/controller.mjs";

assert.ok(process.env.PI_TEST_PACKAGE_DIR, "Run with node scripts/test.mjs.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function controllerHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers = [];
  const finals = [];
  const notices = [];
  const changes = [];
  const controller = new VoiceController({
    createWorker(callbacks) {
      const worker = {
        ...callbacks,
        commands: [],
        closed: 0,
        send(event) {
          this.commands.push(event);
          return true;
        },
        close() {
          this.closed++;
          return Promise.resolve();
        },
      };
      workers.push(worker);
      return worker;
    },
    onFinal(...args) {
      finals.push(args);
      return true;
    },
    onNotice: (...args) => notices.push(args),
    onChange: () => changes.push(controller.state),
    ...options,
  });
  t.after(() => controller.disable());
  return { controller, workers, finals, notices, changes };
}

function ready(harness) {
  harness.controller.enable();
  const worker = harness.workers.at(-1);
  worker.onEvent({ type: "ready" });
  return worker;
}

function record(harness, target = { editor: "synthetic" }) {
  const worker = ready(harness);
  harness.controller.start(target);
  const { id } = worker.commands.at(-1);
  worker.onEvent({ type: "recording", id });
  return { worker, id, target };
}

test("overlapping disables join cleanup and cannot launch a second worker", async (t) => {
  const h = controllerHarness(t);
  const worker = ready(h);
  let finish;
  worker.close = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = h.controller.disable();
  const second = h.controller.disable();
  assert.equal(first, second);
  h.controller.enable();
  assert.equal(h.controller.state, "off");
  assert.equal(h.workers.length, 1);
  finish();
  await second;
  h.controller.enable();
  assert.equal(h.workers.length, 2);
});

test("a failed teardown blocks reenabling rather than overlapping capture groups", async (t) => {
  const h = controllerHarness(t);
  const worker = ready(h);
  worker.close = () => Promise.reject(new Error("synthetic failure"));
  await h.controller.disable();
  h.controller.enable();
  assert.equal(h.controller.state, "off");
  assert.equal(h.workers.length, 1);
  assert.match(h.notices.at(-1)[0], /Restart Pi/);
});

class FakePipe extends EventEmitter {
  writes = [];
  ends = [];
  destroyed = false;
  writeError;
  throwWrite = false;

  write(text, callback) {
    this.writes.push(text);
    if (this.throwWrite)
      throw Object.assign(new Error("private detail"), { code: "EPIPE" });
    callback?.(this.writeError);
    return true;
  }

  end(text, callback) {
    this.ends.push(text);
    callback?.();
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  pid = process.pid + 10_000;
  stdin = new FakePipe();
  stdout = new FakePipe();
  alive = true;
  exited = false;

  exit() {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 1, null);
    this.emit("close", 1, null);
  }
}

function clientHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new FakeChild();
  if ("pid" in options) child.pid = options.pid;
  const spawns = [];
  const signals = [];
  const events = [];
  const errors = [];
  t.mock.method(childProcess, "spawn", (...args) => {
    spawns.push(args);
    if (options.spawnError) throw options.spawnError;
    return child;
  });
  syncBuiltinESMExports();
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(
      pid,
      -child.pid,
      "only the newly detached group may be targeted",
    );
    assert.notEqual(pid, -process.pid);
    signals.push(signal);
    if (!child.alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (
      !options.unstoppable &&
      (signal === "SIGKILL" || (options.termExits && signal === "SIGTERM"))
    ) {
      child.alive = false;
      if (!options.delayReap) child.exit();
    }
    return true;
  });
  const handle = launchWorker({
    device: ":fixture",
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  const emit = (event) =>
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  async function close() {
    const promise = handle.close();
    t.mock.timers.tick(150);
    t.mock.timers.tick(500);
    for (let i = 0; i < 60; i++) t.mock.timers.tick(25);
    await promise;
  }
  t.after(async () => {
    try {
      if (options.unstoppable)
        await assert.rejects(close(), /Voice worker did not stop/);
      else await close();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  return { handle, child, spawns, signals, events, errors, emit, close };
}

test("voice modules and controller construction do not spawn or allocate timers", async (t) => {
  t.mock.method(childProcess, "spawn", () => assert.fail("spawned on import"));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(globalThis, "setTimeout", () => assert.fail("timer on import"));
  const listeners = process
    .eventNames()
    .map((name) => [name, process.listenerCount(name)]);
  const client = await import("../extensions/voice/client.mjs?cold");
  const controller = await import("../extensions/voice/controller.mjs?cold");
  assert.deepEqual(Object.keys(client), ["launchWorker"]);
  assert.deepEqual(Object.keys(controller), ["VoiceController"]);
  const voice = new controller.VoiceController();
  assert.equal(voice.state, "off");
  assert.equal(voice.preview, "");
  assert.equal(voice.pendingText, "");
  assert.equal(voice.enabled, false);
  assert.deepEqual(
    process.eventNames().map((name) => [name, process.listenerCount(name)]),
    listeners,
  );
});

test("enable and start from off only load; ready never opens the microphone", (t) => {
  const h = controllerHarness(t);
  assert.equal(h.workers.length, 0);
  h.controller.start({ editor: 1 });
  assert.equal(h.controller.state, "loading");
  assert.equal(h.controller.enabled, true);
  h.controller.enable();
  h.controller.start({ editor: 2 });
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.workers[0].commands, []);
  h.workers[0].onEvent({ type: "ready" });
  assert.equal(h.controller.state, "ready");
  assert.deepEqual(h.workers[0].commands, []);
  t.mock.timers.tick(120_000);
  assert.equal(h.controller.state, "ready");
  assert.deepEqual(h.changes, ["loading", "ready"]);
});

test("capture lifecycle replaces previews and delivers only to the original target", (t) => {
  const h = controllerHarness(t);
  const target = { opaque: Symbol("editor") };
  const worker = ready(h);
  h.controller.start(target);
  assert.equal(h.controller.state, "starting");
  assert.deepEqual(worker.commands, [{ type: "start", id: 1 }]);
  h.controller.start({ editor: "other" });
  worker.onEvent({ type: "recording", id: 1 });
  worker.onEvent({ type: "partial", id: 1, text: "sample first" });
  worker.onEvent({ type: "partial", id: 1, text: "replacement" });
  assert.equal(h.controller.preview, "replacement");
  h.controller.stop();
  assert.equal(h.controller.state, "finalizing");
  worker.onEvent({ type: "partial", id: 1, text: "last preview" });
  worker.onEvent({ type: "final", id: 1, text: "synthetic result" });
  assert.deepEqual(h.finals, [
    ["synthetic result", target, { explicit: false }],
  ]);
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.preview, "");
  assert.equal(h.controller.pendingText, "");
  worker.onEvent({ type: "final", id: 1, text: "duplicate" });
  assert.equal(h.finals.length, 1);
});

test("stop during starting stays finalizing despite a late recording acknowledgement", (t) => {
  const h = controllerHarness(t);
  const worker = ready(h);
  h.controller.start({ editor: 1 });
  h.controller.stop();
  worker.onEvent({ type: "recording", id: 1 });
  assert.equal(h.controller.state, "finalizing");
  h.controller.stop();
  assert.deepEqual(
    worker.commands.map((event) => event.type),
    ["start", "stop", "stop"],
  );
  worker.onEvent({ type: "final", id: 1, text: "done" });
  assert.equal(h.controller.state, "ready");
});

test("cancel immediately discards in-flight inference and ignores all old recording events", (t) => {
  const h = controllerHarness(t);
  const { worker, id } = record(h);
  worker.onEvent({ type: "partial", id, text: "discard me" });
  h.controller.stop();
  h.controller.cancel();
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.preview, "");
  assert.deepEqual(worker.commands.at(-1), { type: "cancel", id });
  h.controller.start({ editor: "new" });
  const next = worker.commands.at(-1).id;
  assert.equal(next, id + 1);
  for (const type of ["recording", "partial", "final", "cancelled", "error"])
    worker.onEvent({ type, id, text: "late", message: "late" });
  assert.equal(h.controller.state, "starting");
  assert.equal(h.controller.preview, "");
  assert.equal(h.finals.length, 0);
  assert.equal(h.notices.length, 0);
  worker.onEvent({ type: "final", id: next, text: "new result" });
  assert.equal(h.controller.state, "ready");
  assert.equal(h.finals[0][0], "new result");
});

test("disable replaces generations, clears text and never reuses recording IDs", async (t) => {
  const h = controllerHarness(t);
  const { worker: old, id } = record(h);
  old.onEvent({ type: "partial", id, text: "old text" });
  await h.controller.disable();
  assert.equal(old.closed, 1);
  assert.equal(h.controller.preview, "");
  const current = ready(h);
  h.controller.start({ editor: "new" });
  assert.equal(current.commands.at(-1).id, id + 1);
  old.onEvent({ type: "ready" });
  old.onEvent({ type: "partial", id, text: "old preview" });
  old.onEvent({ type: "final", id, text: "old final" });
  old.onEvent({ type: "error", message: "old error" });
  old.onError(new Error("old crash"));
  assert.equal(h.controller.state, "starting");
  assert.equal(h.controller.preview, "");
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.finals, []);
});

test("undelivered final stays pending until explicitly accepted by a new target", (t) => {
  const attempts = [];
  let accepted = false;
  const h = controllerHarness(t, {
    onFinal: (...args) => {
      attempts.push(args);
      return accepted;
    },
  });
  const { worker, id, target } = record(h);
  worker.onEvent({ type: "final", id, text: "pending sample" });
  assert.equal(h.controller.state, "pending");
  assert.equal(h.controller.pendingText, "pending sample");
  assert.equal(h.controller.preview, "pending sample");
  const other = { editor: "replacement" };
  h.controller.start(other);
  assert.equal(worker.commands.length, 1, "pending acceptance must not record");
  assert.equal(h.controller.state, "pending");
  assert.deepEqual(attempts, [
    ["pending sample", target, { explicit: false }],
    ["pending sample", other, { explicit: true }],
  ]);
  accepted = true;
  assert.equal(h.controller.insertPending(other), true);
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.preview, "");
  assert.equal(h.controller.pendingText, "");
  assert.equal(h.controller.insertPending(other), false);
});

for (const action of ["cancel", "disable"]) {
  test(`${action} clears pending text without inserting it`, async (t) => {
    const h = controllerHarness(t, { onFinal: () => false });
    const { worker, id } = record(h);
    worker.onEvent({ type: "final", id, text: "pending sample" });
    await h.controller[action]();
    assert.equal(h.controller.pendingText, "");
    assert.equal(h.controller.preview, "");
    assert.equal(h.controller.state, action === "cancel" ? "ready" : "off");
  });
}

test("empty finals return ready without an insertion or stale preview", (t) => {
  const h = controllerHarness(t);
  const { worker, id } = record(h);
  worker.onEvent({ type: "partial", id, text: "temporary" });
  worker.onEvent({ type: "final", id, text: " \n\t" });
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.preview, "");
  assert.deepEqual(h.finals, []);
});

test("automatic final delivery cannot revive a controller disabled by the editor", (t) => {
  let controller;
  const h = controllerHarness(t, {
    onFinal: () => {
      void controller.disable();
      return false;
    },
  });
  controller = h.controller;
  const { worker, id } = record(h);
  worker.onEvent({ type: "final", id, text: "synthetic result" });
  assert.equal(controller.state, "off");
  assert.equal(controller.pendingText, "");
});

for (const kind of ["event", "callback", "send", "insertion"]) {
  test(`controller ${kind} errors close capture and show no transcript or raw details`, (t) => {
    const h = controllerHarness(
      t,
      kind === "insertion"
        ? {
            onFinal: () => {
              throw new Error("private transcript\x1b[201~");
            },
          }
        : {},
    );
    const { worker, id } = record(h);
    const error = "private transcript\x1b[201~ /private/cache";
    if (kind === "event") worker.onEvent({ type: "error", id, message: error });
    if (kind === "callback") worker.onError(new Error(error));
    if (kind === "send") {
      worker.send = () => {
        throw new Error(error);
      };
      h.controller.stop();
    }
    if (kind === "insertion")
      worker.onEvent({ type: "final", id, text: "sample" });
    assert.equal(h.controller.state, "off");
    assert.equal(worker.closed, 1);
    assert.equal(h.controller.preview, "");
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0][1], "error");
    assert.doesNotMatch(h.notices[0][0], /private|transcript|\x1b/);
    worker.onError(error);
    assert.equal(h.notices.length, 1);
  });
}

for (const phase of ["loading", "starting", "finalizing"]) {
  test(`${phase} deadline tears down the worker`, (t) => {
    const h = controllerHarness(t, { startupMs: 100, finalizeMs: 100 });
    h.controller.enable();
    const worker = h.workers[0];
    if (phase !== "loading") {
      worker.onEvent({ type: "ready" });
      h.controller.start({ editor: "sample" });
      if (phase === "finalizing") h.controller.stop();
    }
    t.mock.timers.tick(99);
    assert.equal(h.controller.state, phase);
    t.mock.timers.tick(1);
    assert.equal(h.controller.state, "off");
    assert.equal(worker.closed, 1);
    assert.equal(h.notices.length, 1);
    worker.onEvent({ type: "ready" });
    worker.onEvent({ type: "final", id: 1, text: "late" });
    assert.equal(h.controller.state, "off");
  });
}

test("recording deadline independently finalizes and repeated stop cannot extend its deadline", (t) => {
  const h = controllerHarness(t, { recordingMs: 100, finalizeMs: 100 });
  const { worker, id } = record(h);
  t.mock.timers.tick(100);
  assert.equal(h.controller.state, "finalizing");
  assert.deepEqual(worker.commands.at(-1), { type: "stop", id });
  t.mock.timers.tick(99);
  h.controller.stop();
  t.mock.timers.tick(1);
  assert.equal(h.controller.state, "off");
  assert.equal(worker.closed, 1);
});

test("cancel during loading cannot bypass model readiness or erase its deadline", (t) => {
  const h = controllerHarness(t, { startupMs: 100 });
  h.controller.enable();
  h.controller.cancel();
  assert.equal(h.controller.state, "loading");
  h.controller.start({ editor: "sample" });
  assert.deepEqual(h.workers[0].commands, []);
  t.mock.timers.tick(100);
  assert.equal(h.controller.state, "off");
});

test("synchronous factory errors and ready callbacks are generation-safe", async (t) => {
  let closed = 0;
  const h = controllerHarness(t, {
    createWorker({ onError }) {
      onError(new Error("private details"));
      return {
        close: () => {
          closed++;
        },
      };
    },
  });
  h.controller.enable();
  assert.equal(h.controller.state, "off");
  assert.equal(closed, 1);
  assert.equal(h.notices.length, 1);
  await h.controller.disable();
  assert.equal(closed, 1);
  const sync = new VoiceController({
    createWorker({ onEvent }) {
      onEvent({ type: "ready" });
      return { close() {}, send() {} };
    },
  });
  sync.enable();
  assert.equal(sync.state, "ready");
  await sync.disable();
});

test("client launches the exact isolated offline command, with stderr discarded", (t) => {
  const h = clientHarness(t);
  const [command, args, options] = h.spawns[0];
  assert.equal(command, "uv");
  assert.deepEqual(args, [
    "run",
    "--no-project",
    "--offline",
    "--python",
    "3.10",
    "--with",
    "mlx-audio==0.5.3",
    "python",
    "-u",
    resolve(root, "extensions/voice/worker.py"),
    "--device",
    ":fixture",
    "--max-seconds",
    "60",
  ]);
  assert.equal(options.cwd, root);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
  assert.deepEqual(options.env, {
    ...process.env,
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONUNBUFFERED: "1",
  });
  assert.deepEqual(Object.keys(h.handle).sort(), ["close", "send"]);
  assert.deepEqual(h.child.stdin.writes, []);
  assert.equal(h.handle.send({ type: "start", id: 0 }), true);
  assert.equal(
    h.handle.send({ type: "stop", id: Number.MAX_SAFE_INTEGER }),
    true,
  );
  assert.equal(h.handle.send({ type: "cancel", id: 0 }), true);
  assert.deepEqual(
    h.child.stdin.writes.map((line) => JSON.parse(line)),
    [
      { type: "start", id: 0 },
      { type: "stop", id: Number.MAX_SAFE_INTEGER },
      { type: "cancel", id: 0 },
    ],
  );
});

test("client parses fragmented UTF-8 and multiple NDJSON events, stripping terminal controls", (t) => {
  const h = clientHarness(t);
  const text =
    "sample café\x1b[201~\x1b[31m safe\x1b[0m\x1b]52;c;hidden\x07\x00\x9b\u202e\nline\tend";
  const data = Buffer.from(
    `${JSON.stringify({ type: "ready" })}\n${JSON.stringify({ type: "partial", id: 1, text })}\n`,
  );
  for (let i = 0; i < data.length; i++)
    h.child.stdout.emit("data", data.subarray(i, i + 1));
  assert.deepEqual(h.events, [
    { type: "ready" },
    { type: "partial", id: 1, text: "sample café safe\nline\tend" },
  ]);
  h.emit({ type: "cancelled", id: 1 });
  h.emit({ type: "final", id: 1, text: "complete" });
  assert.deepEqual(h.events.at(-1), { type: "final", id: 1, text: "complete" });
  assert.deepEqual(h.errors, []);
});

const malformed = [
  "private raw output\n",
  "null\n",
  "[]\n",
  '{"type":"unknown"}\n',
  '{"type":"ready","id":1}\n',
  '{"type":"partial","id":-1,"text":"sample"}\n',
  '{"type":"partial","id":1.5,"text":"sample"}\n',
  '{"type":"partial","id":9007199254740992,"text":"sample"}\n',
  '{"type":"recording","id":true}\n',
  '{"type":"final","id":1,"text":3}\n',
  '{"type":"error","id":null,"message":"sample"}\n',
  '{"type":"error","message":4}\n',
  `${JSON.stringify({ type: "final", id: 1, text: "x".repeat(16 * 1024 + 1) })}\n`,
  `${JSON.stringify({ type: "partial", id: 1, text: "é".repeat(8193) })}\n`,
  `${JSON.stringify({ type: "error", message: "x".repeat(16 * 1024 + 1) })}\n`,
  "x".repeat(64 * 1024 + 1),
  Buffer.from([0xff, 10]),
];
for (const [index, input] of malformed.entries()) {
  test(`client rejects malformed or oversized input ${index + 1} without echoing it`, (t) => {
    const h = clientHarness(t);
    h.child.stdout.emit("data", Buffer.from(input));
    assert.equal(h.errors.length, 1);
    assert.equal(h.events.length, 0);
    assert.match(h.errors[0], /invalid data/);
    assert.doesNotMatch(h.errors[0], /private|sample|\x1b/);
    h.emit({ type: "ready" });
    h.child.emit("error", new Error("private output"));
    h.child.exit();
    assert.equal(h.errors.length, 1);
    assert.equal(h.events.length, 0);
  });
}

test("client bounds accumulated unterminated lines and accepts exact text byte limit", (t) => {
  const h = clientHarness(t);
  h.emit({
    type: "final",
    id: Number.MAX_SAFE_INTEGER,
    text: "x".repeat(16 * 1024),
  });
  assert.equal(h.events[0].text.length, 16 * 1024);
  h.child.stdout.emit("data", Buffer.alloc(32 * 1024, 32));
  h.child.stdout.emit("data", Buffer.alloc(32 * 1024, 32));
  assert.equal(h.errors.length, 0);
  h.child.stdout.emit("data", Buffer.from("x"));
  assert.equal(h.errors.length, 1);
});

for (const event of [
  { type: "start", id: -1 },
  { type: "start", id: "1" },
  { type: "start", id: 1.1 },
  { type: "start", id: Number.MAX_SAFE_INTEGER + 1 },
  { type: "start", id: 1, text: "private" },
  { type: "shutdown", id: 1 },
  { type: "unknown", id: 1 },
  null,
]) {
  test(`client rejects invalid outgoing control ${JSON.stringify(event)}`, (t) => {
    const h = clientHarness(t);
    assert.equal(h.handle.send(event), false);
    assert.equal(h.child.stdin.writes.length, 0);
    assert.equal(h.errors.length, 1);
  });
}

test("client sends safe actionable model and capture errors once and closes the worker", (t) => {
  const h = clientHarness(t);
  h.emit({
    type: "error",
    message:
      "Could not load local speech model. Requires macOS arm64 and mlx-audio==0.5.3.",
  });
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].message, /Cache the Parakeet model/);
  assert.equal(h.child.stdin.ends.length, 1);
  h.child.exit();
  h.emit({ type: "error", message: "private transcript" });
  assert.equal(h.events.length, 1);
  assert.equal(h.errors.length, 0);
});

test("client never forwards unknown worker error contents", (t) => {
  const h = clientHarness(t);
  h.emit({
    type: "error",
    id: 1,
    message: "private transcript /private/cache\x1b[201~",
  });
  assert.deepEqual(h.events, [
    {
      type: "error",
      id: 1,
      message: "Voice worker failed. Disable voice and retry.",
    },
  ]);
});

test("missing uv is actionable without copying spawn error details", async (t) => {
  const h = clientHarness(t, {
    spawnError: Object.assign(new Error("private path"), { code: "ENOENT" }),
  });
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /uv is missing/);
  assert.doesNotMatch(h.errors[0], /private/);
  await h.close();
  assert.deepEqual(h.signals, []);
});

test("async spawn failure is handled, and does not signal a parent group", async (t) => {
  const h = clientHarness(t);
  // Node returns no pid when executable lookup fails.
  // Use a separate launch after changing the fake pid, before its spawn event.
  await h.close();
  h.child.pid = undefined;
  const errors = [];
  const handle = launchWorker({ onError: (message) => errors.push(message) });
  h.child.emit(
    "error",
    Object.assign(new Error("private path"), { code: "ENOENT" }),
  );
  const promise = handle.close();
  t.mock.timers.tick(150);
  await promise;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /uv is missing/);
});

for (const mode of ["event", "callback", "throw"]) {
  test(`stdin EPIPE via ${mode} notifies once without an unhandled error`, (t) => {
    const h = clientHarness(t);
    const error = Object.assign(new Error("private EPIPE details"), {
      code: "EPIPE",
    });
    if (mode === "event") h.child.stdin.emit("error", error);
    if (mode === "callback") {
      h.child.stdin.writeError = error;
      h.handle.send({ type: "start", id: 1 });
    }
    if (mode === "throw") {
      h.child.stdin.throwWrite = true;
      assert.equal(h.handle.send({ type: "start", id: 1 }), false);
    }
    h.child.stdin.emit("error", error);
    h.child.stdout.emit("error", error);
    h.child.emit("error", error);
    h.child.exit();
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0], /private/);
    assert.equal(h.handle.send({ type: "start", id: 2 }), false);
  });
}

test("early uv exit reports offline dependencies and kills the surviving Python/ffmpeg group", async (t) => {
  const h = clientHarness(t);
  h.child.exit();
  assert.equal(h.child.alive, true, "descendants outlive the uv leader");
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /offline.*Python 3.10.*mlx-audio==0.5.3/);
  await h.close();
  assert.equal(h.child.alive, false);
  assert.ok(h.signals.includes("SIGTERM"));
  assert.ok(h.signals.includes("SIGKILL"));
});

test("close is idempotent, shuts stdin first, escalates the entire group and reaps", async (t) => {
  const h = clientHarness(t);
  const first = h.handle.close();
  assert.equal(h.handle.close(), first);
  assert.deepEqual(h.child.stdin.ends, ['{"type":"shutdown"}\n']);
  assert.deepEqual(h.signals, []);
  h.emit({ type: "ready" });
  h.emit({ type: "final", id: 1, text: "late transcript" });
  assert.deepEqual(h.events, []);
  t.mock.timers.tick(150);
  assert.ok(h.signals.includes("SIGTERM"));
  assert.equal(h.child.alive, true);
  t.mock.timers.tick(500);
  await first;
  assert.equal(h.child.alive, false);
  assert.equal(h.child.exited, true);
  assert.equal(h.child.stdin.destroyed, true);
  assert.equal(h.child.stdout.destroyed, true);
  assert.equal(h.handle.send({ type: "start", id: 1 }), false);
  assert.deepEqual(h.errors, []);
});

test("client drops retired recording IDs without closing the replacement capture", (t) => {
  const h = clientHarness(t);
  h.emit({ type: "ready" });
  h.handle.send({ type: "start", id: 1 });
  h.handle.send({ type: "cancel", id: 1 });
  h.handle.send({ type: "start", id: 2 });
  for (const type of ["recording", "partial", "final", "cancelled", "error"])
    h.emit({
      type,
      id: 1,
      ...(["partial", "final"].includes(type)
        ? { text: "late" }
        : type === "error"
          ? { message: "No active recording with this id." }
          : {}),
    });
  assert.deepEqual(h.events, [{ type: "ready" }]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.child.stdin.ends, []);
  h.emit({ type: "final", id: 2, text: "current" });
  h.emit({
    type: "error",
    id: 2,
    message: "No active recording with this id.",
  });
  assert.deepEqual(h.events.at(-1), { type: "final", id: 2, text: "current" });
  assert.deepEqual(h.child.stdin.ends, []);
});

test("capture errors close once and cannot be followed by duplicate exit notices", (t) => {
  const h = clientHarness(t);
  h.handle.send({ type: "start", id: 1 });
  h.emit({
    type: "error",
    id: 1,
    message: "ffmpeg is missing. Install ffmpeg to use local voice input.",
  });
  h.child.exit();
  h.child.stdin.emit("error", new Error("private detail"));
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].message, /Install ffmpeg/);
  assert.equal(h.errors.length, 0);
});

test("post-ready exits report one short error and close surviving descendants", async (t) => {
  const h = clientHarness(t);
  h.emit({ type: "ready" });
  h.child.exit();
  h.child.emit("error", new Error("private path"));
  assert.deepEqual(h.errors, [
    "Voice worker stopped unexpectedly. Disable voice and retry.",
  ]);
  await h.close();
  assert.equal(h.child.alive, false);
});

test("close waits for the direct child to be reaped after the group has been killed", async (t) => {
  const h = clientHarness(t, { delayReap: true });
  let finished = false;
  const promise = h.handle.close().then(() => {
    finished = true;
  });
  t.mock.timers.tick(150);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(h.child.alive, false);
  assert.equal(finished, false);
  h.child.exit();
  t.mock.timers.tick(25);
  await promise;
  assert.equal(finished, true);
});

test("teardown is bounded and rejects rather than claiming an unkillable group was reaped", async (t) => {
  const h = clientHarness(t, { unstoppable: true });
  const rejected = assert.rejects(
    h.handle.close(),
    /Voice worker did not stop/,
  );
  t.mock.timers.tick(150);
  t.mock.timers.tick(500);
  for (let i = 0; i < 60; i++) t.mock.timers.tick(25);
  await rejected;
  assert.ok(h.signals.includes("SIGKILL"));
  assert.equal(h.child.alive, true);
});

test("invalid child PIDs can never target this process or its parent group", async (t) => {
  const h = clientHarness(t, { pid: process.pid });
  h.child.exit();
  await h.close();
  assert.deepEqual(h.signals, []);
});

test("client has a bounded standalone startup deadline", async (t) => {
  const h = clientHarness(t);
  t.mock.timers.tick(60_000);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /startup timed out/);
  await h.close();
});

test("ready clears the client startup deadline", (t) => {
  const h = clientHarness(t);
  h.emit({ type: "ready" });
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.errors, []);
});
