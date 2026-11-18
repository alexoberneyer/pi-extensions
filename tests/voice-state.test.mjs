import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchWorker } from "../extensions/voice/client.mjs";
import { IDLE_MS, VoiceController } from "../extensions/voice/controller.mjs";

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

test("failed worker ownership remains blocked in a recreated controller", async (t) => {
  const safety = { teardownFailed: false };
  const old = controllerHarness(t, { safety });
  const worker = ready(old);
  worker.close = () => Promise.reject(new Error("synthetic teardown failure"));
  await old.controller.disable();
  const notices = [];
  const replacement = new VoiceController({
    safety,
    createWorker: () =>
      assert.fail("Failed ownership must prevent replacement"),
    onNotice: (message) => notices.push(message),
  });
  t.after(() => replacement.disable());
  replacement.enable({ warm: false });
  assert.equal(replacement.enabled, false);
  replacement.enable();
  assert.match(notices.at(-1), /Restart Pi/);
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
  assert.deepEqual(Object.keys(controller), [
    "IDLE_MS",
    "VoiceController",
    "getVoiceWorkerSafety",
  ]);
  const regular = await import("../extensions/voice/controller.mjs");
  assert.equal(
    controller.getVoiceWorkerSafety(),
    regular.getVoiceWorkerSafety(),
  );
  assert.equal(controller.IDLE_MS, 300_000);
  const voice = new controller.VoiceController();
  assert.equal(voice.state, "off");
  assert.equal(voice.preview, "");
  assert.equal(voice.pendingText, "");
  assert.equal(voice.enabled, false);
  assert.equal(voice.recordingRequested, false);
  voice.enable({ warm: false });
  assert.equal(voice.state, "standby");
  assert.equal(voice.enabled, true);
  assert.equal(voice.recordingRequested, false);
  voice.enable({ warm: false });
  voice.stop();
  voice.cancel();
  assert.equal(voice.state, "standby");
  await voice.disable();
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
  assert.equal(h.controller.recordingRequested, false);
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

const flushCleanup = () => new Promise(setImmediate);

for (const action of ["warm", "enable"]) {
  test(`${action} explicitly warms standby without requesting capture`, (t) => {
    const h = controllerHarness(t);
    h.controller.enable({ warm: false });
    assert.equal(h.workers.length, 0);
    h.controller[action]();
    assert.equal(h.controller.state, "loading");
    assert.equal(h.controller.enabled, true);
    assert.equal(h.controller.recordingRequested, false);
    h.workers[0].onEvent({ type: "ready" });
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(h.workers[0].commands, []);
  });
}

test("five idle minutes close the entire worker while voice stays enabled", async (t) => {
  const h = controllerHarness(t);
  const worker = ready(h);
  t.mock.timers.tick(IDLE_MS - 1);
  assert.equal(worker.closed, 0);
  assert.equal(h.controller.state, "ready");
  t.mock.timers.tick(1);
  assert.equal(worker.closed, 1);
  assert.equal(h.controller.state, "standby");
  assert.equal(h.controller.enabled, true);
  assert.equal(h.controller.recordingRequested, false);
  t.mock.timers.tick(IDLE_MS * 2);
  assert.equal(worker.closed, 1);
  await flushCleanup();
  assert.deepEqual(h.notices, []);
});

for (const initial of ["standby", "loading"]) {
  test(`an explicit start in ${initial} queues capture for the original target`, (t) => {
    const h = controllerHarness(t);
    const target = { editor: "synthetic cold target" };
    h.controller.enable({ warm: initial === "loading" });
    h.controller.start(target);
    const worker = h.workers[0];
    assert.equal(h.controller.state, "loading");
    assert.equal(h.controller.recordingRequested, true);
    assert.deepEqual(worker.commands, []);
    worker.onEvent({ type: "ready" });
    assert.equal(h.controller.state, "starting");
    assert.equal(h.controller.recordingRequested, true);
    assert.deepEqual(worker.commands, [{ type: "start", id: 1 }]);
    worker.onEvent({ type: "recording", id: 1 });
    assert.equal(h.controller.recordingRequested, true);
    h.controller.stop();
    assert.equal(h.controller.recordingRequested, true);
    worker.onEvent({ type: "final", id: 1, text: "cold result" });
    assert.equal(h.controller.state, "ready");
    assert.equal(h.controller.recordingRequested, false);
    assert.deepEqual(h.finals, [["cold result", target, { explicit: false }]]);
  });
}

for (const action of ["stop", "cancel"]) {
  test(`${action} during a cold hold or toggle retires intent before model readiness`, (t) => {
    const h = controllerHarness(t, { idleMs: 100 });
    h.controller.enable({ warm: false });
    h.controller.start({ editor: "released target" });
    const worker = h.workers[0];
    t.mock.timers.tick(50);
    h.controller[action]();
    assert.equal(h.controller.state, "loading");
    assert.equal(h.controller.enabled, true);
    assert.equal(h.controller.recordingRequested, false);
    worker.onEvent({ type: "ready" });
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(worker.commands, []);
    for (const type of ["recording", "partial", "final", "cancelled", "error"])
      worker.onEvent({ type, id: 1, text: "late", message: "late" });
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(h.finals, []);
    assert.deepEqual(h.notices, []);
    t.mock.timers.tick(99);
    assert.equal(worker.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(worker.closed, 1);
    assert.equal(h.controller.state, "standby");
  });

  test(`${action} clears queued intent without resetting the startup deadline`, (t) => {
    const h = controllerHarness(t, { startupMs: 100, idleMs: 10 });
    h.controller.enable({ warm: false });
    h.controller.start({ editor: "sample" });
    const worker = h.workers[0];
    t.mock.timers.tick(90);
    h.controller[action]();
    assert.equal(h.controller.recordingRequested, false);
    t.mock.timers.tick(9);
    assert.equal(h.controller.state, "loading");
    assert.equal(worker.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(h.controller.state, "off");
    assert.equal(worker.closed, 1);
    worker.onEvent({ type: "ready" });
    assert.deepEqual(worker.commands, []);
  });
}

test("a new gesture after an early release can queue a fresh target without another worker", (t) => {
  const h = controllerHarness(t);
  h.controller.enable({ warm: false });
  h.controller.start({ editor: "released" });
  h.controller.stop();
  const target = { editor: "new gesture" };
  h.controller.start(target);
  h.workers[0].onEvent({ type: "ready" });
  h.workers[0].onEvent({ type: "final", id: 1, text: "new result" });
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.finals, [["new result", target, { explicit: false }]]);
});

test("off during a queued load cannot revive capture through late callbacks", async (t) => {
  const h = controllerHarness(t, { startupMs: 100, idleMs: 100 });
  h.controller.enable({ warm: false });
  h.controller.start({ editor: "old" });
  const old = h.workers[0];
  await h.controller.disable();
  assert.equal(h.controller.recordingRequested, false);
  h.controller.enable({ warm: false });
  old.onEvent({ type: "ready" });
  old.onEvent({ type: "error", message: "private model failure" });
  old.onError(new Error("private model failure"));
  t.mock.timers.tick(1_000);
  assert.equal(h.controller.state, "standby");
  assert.equal(h.controller.enabled, true);
  assert.equal(h.workers.length, 1);
  assert.equal(old.closed, 1);
  assert.deepEqual(old.commands, []);
  assert.deepEqual(h.notices, []);
});

for (const action of ["insertPending", "start", "cancel", "disable"]) {
  test(`pending text survives idle unload and ${action} never wakes a model`, async (t) => {
    let accepted = false;
    const attempts = [];
    const h = controllerHarness(t, {
      idleMs: 100,
      onFinal: (...args) => {
        attempts.push(args);
        return accepted;
      },
    });
    const { worker, id, target } = record(h);
    worker.onEvent({ type: "final", id, text: "pending sample" });
    assert.equal(h.controller.recordingRequested, false);
    t.mock.timers.tick(100);
    assert.equal(worker.closed, 1);
    assert.equal(h.controller.enabled, true);
    assert.equal(h.controller.state, "pending");
    assert.equal(h.controller.pendingText, "pending sample");
    assert.equal(h.controller.preview, "pending sample");
    h.controller.enable();
    h.controller.warm();
    const replacement = { editor: "replacement" };
    assert.equal(h.controller.insertPending(replacement), false);
    assert.equal(h.controller.state, "pending");
    assert.equal(h.workers.length, 1);
    accepted = true;
    await h.controller[action](replacement);
    assert.equal(h.workers.length, 1);
    assert.equal(h.controller.state, action === "disable" ? "off" : "standby");
    assert.equal(h.controller.enabled, action !== "disable");
    assert.equal(h.controller.recordingRequested, false);
    assert.equal(h.controller.pendingText, "");
    assert.equal(h.controller.preview, "");
    assert.deepEqual(attempts, [
      ["pending sample", target, { explicit: false }],
      ["pending sample", replacement, { explicit: true }],
      ...(["start", "insertPending"].includes(action)
        ? [["pending sample", replacement, { explicit: true }]]
        : []),
    ]);
    t.mock.timers.tick(1_000);
    assert.equal(worker.closed, 1);
  });
}

test("idle unload invalidates every old worker callback and preserves increasing request IDs", async (t) => {
  const h = controllerHarness(t, { idleMs: 100 });
  const { worker: old, id } = record(h);
  old.onEvent({ type: "final", id, text: "first result" });
  t.mock.timers.tick(100);
  await flushCleanup();
  h.controller.start({ editor: "new target" });
  const current = h.workers[1];
  for (const phase of ["loading", "starting"]) {
    if (phase === "starting") current.onEvent({ type: "ready" });
    old.onEvent({ type: "ready" });
    for (const type of ["recording", "partial", "final", "cancelled", "error"])
      old.onEvent({ type, id, text: "late", message: "late" });
    old.onEvent({ type: "error", message: "late model error" });
    old.onError(new Error("late crash"));
    assert.equal(h.controller.state, phase);
    assert.equal(h.controller.recordingRequested, true);
    assert.equal(h.controller.preview, "");
    assert.deepEqual(h.notices, []);
    assert.equal(h.finals.length, 1);
  }
  assert.deepEqual(current.commands, [{ type: "start", id: id + 1 }]);
});

for (const action of ["keep", "stop", "cancel", "disable"]) {
  test(`a start during idle cleanup waits for close and honors ${action}`, async (t) => {
    const h = controllerHarness(t, { idleMs: 100, startupMs: 100 });
    const old = ready(h);
    let finish;
    old.close = () => {
      old.closed++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    t.mock.timers.tick(100);
    h.controller.start({ editor: "queued replacement" });
    assert.equal(h.controller.state, "loading");
    assert.equal(h.controller.recordingRequested, true);
    assert.equal(h.workers.length, 1);
    t.mock.timers.tick(1_000);
    assert.equal(h.controller.state, "loading", "startup waits for cleanup");
    let closing;
    if (action === "stop") h.controller.stop();
    if (action === "cancel") {
      h.controller.cancel();
      assert.equal(h.controller.state, "standby");
    }
    if (action === "disable") {
      closing = h.controller.disable();
      assert.equal(closing, h.controller.disable());
    }
    finish();
    await closing;
    await flushCleanup();
    assert.equal(old.closed, 1);
    assert.equal(h.workers.length, ["keep", "stop"].includes(action) ? 2 : 1);
    if (["keep", "stop"].includes(action)) {
      const replacement = h.workers[1];
      assert.equal(h.controller.state, "loading");
      replacement.onEvent({ type: "ready" });
      assert.equal(
        h.controller.state,
        action === "keep" ? "starting" : "ready",
      );
      assert.deepEqual(
        replacement.commands,
        action === "keep" ? [{ type: "start", id: 1 }] : [],
      );
      assert.equal(h.controller.recordingRequested, action === "keep");
    } else {
      assert.equal(h.controller.state, action === "cancel" ? "standby" : "off");
      assert.equal(h.controller.recordingRequested, false);
    }
    assert.deepEqual(h.notices, []);
  });
}

for (const mode of ["reject", "throw"]) {
  test(`idle cleanup ${mode} blocks a queued replacement and warns safely`, async (t) => {
    const h = controllerHarness(t, { idleMs: 100 });
    const old = ready(h);
    old.close = () => {
      old.closed++;
      const error = new Error("private teardown details");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    };
    t.mock.timers.tick(100);
    h.controller.start({ editor: "blocked replacement" });
    await flushCleanup();
    assert.equal(h.controller.state, "off");
    assert.equal(h.controller.recordingRequested, false);
    h.controller.enable();
    h.controller.start({ editor: "still blocked" });
    assert.equal(h.controller.state, "off");
    assert.equal(h.workers.length, 1);
    assert.equal(old.closed, 1);
    assert.ok(h.notices.length > 0);
    for (const [message, level] of h.notices) {
      assert.match(message, /Restart Pi/);
      assert.doesNotMatch(message, /private|details/);
      assert.equal(level, "error");
    }
  });
}

test("a cold start rechecks its target after loading and a false guard leaves it idle", (t) => {
  let focused = true;
  const targets = [];
  const h = controllerHarness(t, {
    idleMs: 100,
    canStart: (target) => {
      targets.push(target);
      return focused;
    },
  });
  const target = { editor: "main" };
  h.controller.enable({ warm: false });
  h.controller.start(target);
  focused = false;
  h.workers[0].onEvent({ type: "ready" });
  assert.deepEqual(targets, [target]);
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.recordingRequested, false);
  assert.deepEqual(h.workers[0].commands, []);
  t.mock.timers.tick(100);
  assert.equal(h.controller.state, "standby");
});

for (const action of ["stop", "cancel", "disable", "throw"]) {
  test(`canStart ${action} cannot open the microphone reentrantly`, (t) => {
    let controller;
    const h = controllerHarness(t, {
      canStart: () => {
        if (action === "throw") throw new Error("private focus details");
        controller[action]();
        return true;
      },
    });
    controller = h.controller;
    controller.enable({ warm: false });
    controller.start({ editor: "main" });
    h.workers[0].onEvent({ type: "ready" });
    assert.equal(controller.state, action === "disable" ? "off" : "ready");
    assert.equal(controller.recordingRequested, false);
    assert.deepEqual(h.workers[0].commands, []);
    assert.deepEqual(h.notices, []);
  });
}

for (const phase of ["loading", "starting", "recording", "finalizing"]) {
  test(`idle timeout never closes a ${phase} worker`, (t) => {
    const h = controllerHarness(t, {
      idleMs: 100,
      startupMs: 1_000,
      finalizeMs: 1_000,
      recordingMs: 1_000,
    });
    h.controller.enable();
    const worker = h.workers[0];
    if (phase !== "loading") {
      worker.onEvent({ type: "ready" });
      t.mock.timers.tick(99);
      h.controller.start({ editor: "sample" });
      if (["recording", "finalizing"].includes(phase))
        worker.onEvent({ type: "recording", id: 1 });
      if (phase === "finalizing") h.controller.stop();
    }
    t.mock.timers.tick(101);
    assert.equal(h.controller.state, phase);
    assert.equal(worker.closed, 0);
  });
}

for (const outcome of ["final", "cancel", "cancelled", "empty"]) {
  test(`${outcome} resets idle time after capture`, (t) => {
    const h = controllerHarness(t, { idleMs: 100 });
    const { worker, id } = record(h);
    t.mock.timers.tick(90);
    if (outcome === "cancel") h.controller.cancel();
    else
      worker.onEvent({
        type: outcome === "cancelled" ? "cancelled" : "final",
        id,
        text: outcome === "empty" ? " " : "sample result",
      });
    assert.equal(h.controller.state, "ready");
    assert.equal(h.controller.recordingRequested, false);
    t.mock.timers.tick(99);
    assert.equal(worker.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(h.controller.state, "standby");
    assert.equal(worker.closed, 1);
  });
}

for (const action of ["insertPending", "start", "cancel"]) {
  test(`${action} resets a resident pending worker's idle deadline`, (t) => {
    let accepted = false;
    const h = controllerHarness(t, { idleMs: 100, onFinal: () => accepted });
    const { worker, id } = record(h);
    worker.onEvent({ type: "final", id, text: "pending result" });
    t.mock.timers.tick(90);
    h.controller.insertPending({ editor: "unavailable" });
    t.mock.timers.tick(99);
    assert.equal(worker.closed, 0);
    assert.equal(h.controller.state, "pending");
    accepted = true;
    h.controller[action]({ editor: "replacement" });
    assert.equal(h.controller.state, "ready");
    t.mock.timers.tick(99);
    assert.equal(worker.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(worker.closed, 1);
    assert.equal(h.controller.state, "standby");
  });
}

test("empty cancel preserves ready idle time and disable clears every outstanding timer", async (t) => {
  const h = controllerHarness(t, { idleMs: 100 });
  const old = ready(h);
  t.mock.timers.tick(90);
  h.controller.cancel();
  t.mock.timers.tick(9);
  assert.equal(old.closed, 0);
  t.mock.timers.tick(1);
  assert.equal(old.closed, 1);
  assert.equal(h.controller.state, "standby");
  await h.controller.disable();
  h.controller.enable({ warm: false });
  t.mock.timers.tick(1_000);
  assert.equal(h.controller.state, "standby");
  assert.equal(h.workers.length, 1);
  assert.equal(old.closed, 1);
});

test("synchronous ready assigns the worker before sending a queued cold start", (t) => {
  const commands = [];
  let assigned = false;
  const h = controllerHarness(t, {
    idleMs: 100,
    createWorker({ onEvent }) {
      onEvent({ type: "ready" });
      assigned = true;
      return {
        send(event) {
          assert.equal(assigned, true);
          commands.push(event);
          onEvent({ type: "recording", id: event.id });
          return true;
        },
        close() {},
      };
    },
  });
  h.controller.enable({ warm: false });
  h.controller.start({ editor: "sample" });
  assert.equal(h.controller.state, "recording");
  assert.equal(h.controller.recordingRequested, true);
  assert.deepEqual(commands, [{ type: "start", id: 1 }]);
  t.mock.timers.tick(100);
  assert.equal(h.controller.state, "recording");
});

for (const kind of ["callback", "event", "throw"]) {
  test(`synchronous factory ${kind} failure clears queued capture and ignores late ready`, (t) => {
    let callbacks;
    let closed = 0;
    const commands = [];
    const h = controllerHarness(t, {
      createWorker(handlers) {
        callbacks = handlers;
        const message = "private model details";
        if (kind === "throw") throw new Error(message);
        if (kind === "callback") handlers.onError(new Error(message));
        else handlers.onEvent({ type: "error", message });
        handlers.onEvent({ type: "ready" });
        return {
          send: (event) => commands.push(event),
          close: () => {
            closed++;
          },
        };
      },
    });
    h.controller.enable({ warm: false });
    h.controller.start({ editor: "sample" });
    assert.equal(h.controller.state, "off");
    assert.equal(h.controller.recordingRequested, false);
    assert.equal(closed, kind === "throw" ? 0 : 1);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0][0], /model/);
    assert.doesNotMatch(h.notices[0][0], /private|details/);
    callbacks.onEvent({ type: "ready" });
    assert.deepEqual(commands, []);
    assert.equal(h.controller.state, "off");
  });
}

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
