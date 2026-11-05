import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(
  packageDir,
  "Run through node scripts/test.mjs or set PI_TEST_PACKAGE_DIR.",
);
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: Object.fromEntries(
    ["pi-coding-agent", "pi-ai", "pi-tui"]
      .map((name) => [
        `@earendil-works/${name}`,
        name === "pi-coding-agent"
          ? join(packageDir, "dist/index.js")
          : join(dirname(packageDir), name, "dist/index.js"),
      ])
      .concat([["typebox", require.resolve("typebox")]]),
  ),
});
const source = join(root, "extensions/supervisor");
const { WorkerRpc } = await jiti.import(join(source, "rpc.ts"));
const { Supervisor, report } = await jiti.import(join(source, "manager.ts"));
const { Store } = await jiti.import(join(source, "store.ts"));
const {
  clean,
  workerArgs,
  default: supervisorExtension,
} = await jiti.import(join(source, "index.ts"));
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { SessionManager, createEventBus } = await import(
  pathToFileURL(join(packageDir, "dist/index.js"))
);
const { buildSystemPrompt } = await import(
  pathToFileURL(join(packageDir, "dist/core/system-prompt.js"))
);
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const { getKeybindings, visibleWidth } = await import(
  pathToFileURL(join(dirname(packageDir), "pi-tui/dist/index.js"))
);

const disposals = new WeakMap();
function cleanup(t, callback) {
  disposals.get(t).push(callback);
}

function temporary(t) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pi-supervisor-test-")),
  );
  if (!disposals.has(t)) {
    const callbacks = [];
    disposals.set(t, callbacks);
    t.after(async () => {
      for (const callback of callbacks.reverse()) await callback();
    });
  }
  cleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function until(predicate, label = "condition") {
  const end = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fixtureSource = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf('--session') + 1] || '/fixture.jsonl';
const contract = JSON.parse(process.env.PI_SUPERVISOR_CONTRACT || '{}');
const mode = contract.objective || process.env.FIXTURE_MODE || 'complete';
const sessionId = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).id : randomUUID();
let busy = false;
let framed = false;
let lastId = null;
const messages = [];
function trace(value) { if (process.env.FIXTURE_TRACE) appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + '\n'); }
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function response(command, data = {}) { emit({type:'response', id:command.id, command:command.type, success:true, data}); }
function persist(message) {
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({type:'session', version:3, id:sessionId, cwd:process.cwd()}) + '\n', {mode:0o600});
  const id = randomUUID().slice(0,8);
  appendFileSync(sessionFile, JSON.stringify({type:'message', id, parentId:lastId, timestamp:new Date().toISOString(), message}) + '\n');
  lastId = id;
  messages.push(message);
}
function finish(kind = mode) {
  if (!busy) return;
  const summary = 'Evidence ä\u2028x\u2029y'.replaceAll('\\u2028', '\u2028').replaceAll('\\u2029', '\u2029');
  const message = {role:'assistant', content:[{type:'text', text:summary}], stopReason:kind === 'error' ? 'error' : 'stop', errorMessage:kind === 'error' ? 'fixture model failed' : undefined, timestamp:Date.now()};
  persist(message);
  emit({type:'message_end', message});
  if (!['no-report', 'error'].includes(kind)) emit({type:'tool_execution_end', toolName:'worker_report', isError:false, result:{details:{status:kind === 'blocked' ? 'blocked' : 'complete', summary, evidence:['test.ts:42 passed']}}});
  emit({type:'agent_end'});
  busy = false;
  emit({type:'agent_settled', aborted:false});
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    trace(command);
    if (command.type === 'extension_ui_response') { finish(command.confirmed ? 'complete' : 'blocked'); continue; }
    if (command.type === 'get_state') {
      if (mode === 'never-ready') continue;
      if (mode === 'malformed') { process.stdout.write('not json\n'); continue; }
      const data = {sessionFile, sessionId, isStreaming:busy, unicode:'ä\u2028\u2029'};
      if (mode === 'wrong-identity') data.sessionFile = '/wrong.jsonl';
      const record = JSON.stringify({type:'response', id:command.id, success:true, data}) + '\r\n';
      if (mode === 'framing' && !framed) {
        framed = true;
        const bytes = Buffer.from(record); const at = bytes.indexOf(Buffer.from('ä')) + 1;
        process.stdout.write(bytes.subarray(0, at));
        setTimeout(() => process.stdout.write(bytes.subarray(at)), 5);
      } else response(command, data);
    } else if (command.type === 'get_commands') {
      if (mode === 'broken-guard') emit({type:'extension_error', error:'fixture guard failed'});
      const names = ['pi-extensions-approval-ready-v1', 'pi-extensions-worker-ready-v1']
        .filter(name => mode !== 'missing-approval' || !name.includes('approval'))
        .filter(name => mode !== 'missing-worker' || !name.includes('worker'));
      response(command, {commands:names.map(name => ({name, source:mode === 'spoofed-guard' ? 'prompt' : 'extension'}))});
    } else if (command.type === 'prompt') {
      if (mode === 'reject') { emit({type:'response', id:command.id, success:false, error:'fixture rejected'}); continue; }
      if (mode === 'handled') { response(command, {disposition:'handled'}); continue; }
      persist({role:'user', content:command.message, timestamp:Date.now()});
      busy = true; emit({type:'agent_start'});
      if (mode !== 'lost-ack') response(command, {disposition:'started'});
      if (mode === 'crash') { process.exit(7); }
      else if (mode === 'input') emit({type:'extension_ui_request', id:'approval-1', method:'confirm', title:'Publish?', message:'git push origin main'});
      else if (mode === 'timed-input') {
        emit({type:'extension_ui_request', id:'approval-1', method:'confirm', title:'Timed input', message:'No action', timeout:20});
        setTimeout(() => finish('blocked'), 50);
      }
      else if (mode === 'retry') { emit({type:'agent_end'}); setTimeout(() => finish('complete'), 30); }
      else if (!['slow', 'lost-ack'].includes(mode)) finish();
    } else if (command.type === 'clear_queue') response(command, {steering:[], followUp:[]});
    else if (command.type === 'abort') { if (busy) { busy = false; emit({type:'agent_settled', aborted:true}); } response(command); }
    else if (command.type === 'get_messages') response(command, {messages});
    else if (command.type === 'get_last_assistant_text') response(command, {text:'last response'});
    else emit({type:'response', id:command.id, success:false, error:'unsupported command'});
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function fixture(t) {
  const directory = temporary(t);
  const file = join(directory, "worker.mjs");
  writeFileSync(file, fixtureSource);
  return { directory, file };
}

function setup(t, extra = {}) {
  const { directory, file } = fixture(t);
  const events = [];
  const trace = join(directory, "trace.jsonl");
  const store = new Store(join(directory, "private"), "parent-session");
  const manager = new Supervisor(store, {
    command: process.execPath,
    args: [file],
    env: { ...process.env, FIXTURE_TRACE: trace },
    changed() {},
    event(worker, kind) {
      events.push({ ...structuredClone(worker), kind });
    },
    timeout: 1_000,
    ...extra,
  });
  cleanup(t, () => manager.close());
  function task(objective = "complete") {
    return {
      name: "Investigate imports",
      objective,
      scope: "Read test.ts only",
      acceptance: "Return exact failing assertion",
      cwd: directory,
    };
  }
  return { directory, manager, store, events, trace, task };
}

function traffic(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
}

test("private store is lazy, atomic and exclusively claimed", (t) => {
  const directory = temporary(t);
  const first = new Store(directory, "parent");
  const second = new Store(directory, "parent");
  assert.equal(existsSync(first.directory), false);
  first.acquire();
  first.save();
  assert.equal(statSync(first.directory).mode & 0o777, 0o700);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.equal(statSync(first.lease).mode & 0o777, 0o600);
  assert.throws(() => second.acquire(), /already claimed/);
  first.release();
  second.acquire();
  second.release();
});

test("stale or corrupt leases are never silently reclaimed", (t) => {
  const directory = temporary(t);
  const store = new Store(directory, "parent");
  mkdirSync(store.directory);
  writeFileSync(store.lease, JSON.stringify({ pid: 999999999, token: "old" }));
  assert.throws(() => store.acquire(), /never reclaimed automatically/);
  assert.equal(JSON.parse(readFileSync(store.lease)).token, "old");
});

test("completion arrives once at settlement and follow-ups retain one conversation", async (t) => {
  const { manager, task, events, trace } = setup(t);
  const worker = await manager.launch(task());
  await until(() => events.some((event) => event.kind === "result"));
  assert.equal(worker.status, "reported");
  assert.equal(events.filter((event) => event.kind === "result").length, 1);
  const { sessionId, sessionFile, pid } = worker;
  await manager.send(worker.id, "Check one more assertion", "supervisor");
  await until(
    () => events.filter((event) => event.kind === "result").length === 2,
  );
  assert.equal(worker.sessionId, sessionId);
  assert.equal(worker.sessionFile, sessionFile);
  assert.equal(worker.pid, pid);
  assert.deepEqual(
    traffic(trace)
      .slice(0, 3)
      .map((event) => event.type),
    ["get_state", "get_commands", "prompt"],
  );
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    2,
  );
  assert.match(await manager.inspect(worker.id), /Check one more assertion/);
});

test("retry agent_end does not complete a task", async (t) => {
  const { manager, task, events } = setup(t);
  const worker = await manager.launch(task("retry"));
  assert.equal(worker.status, "working");
  assert.equal(events.length, 0);
  await until(() => worker.status === "reported");
  assert.equal(events.length, 1);
});

for (const [mode, expected] of [
  ["blocked", "blocked"],
  ["no-report", "needs-review"],
  ["error", "error"],
  ["handled", "needs-review"],
]) {
  test(`${mode} is classified as ${expected}, never verified completion`, async (t) => {
    const { manager, task } = setup(t);
    const worker = await manager.launch(task(mode));
    await until(() => worker.status === expected);
  });
}

test("manual takeover interrupts work and blocks model instructions until return", async (t) => {
  const { manager, task, trace, events } = setup(t);
  const worker = await manager.launch(task("slow"));
  await manager.take(worker.id);
  assert.equal(worker.owner, "human");
  assert.equal(worker.status, "stopped");
  await assert.rejects(
    manager.send(worker.id, "model instruction", "supervisor"),
    /controlled by human/,
  );
  await manager.send(worker.id, "human clarification", "human");
  await manager.giveBack(worker.id);
  assert.equal(worker.owner, "supervisor");
  assert.equal(worker.lastInstruction, "human clarification");
  assert.equal(events.at(-1).kind, "control");
  assert.equal(events.at(-1).lastInstruction, "human clarification");
  const types = traffic(trace).map((event) => event.type);
  assert.ok(types.indexOf("clear_queue") < types.indexOf("abort"));
  assert.equal(types.filter((type) => type === "prompt").length, 2);
});

test("approval waits for a human answer and stopping cancels it first", async (t) => {
  const { manager, task, trace, events } = setup(t);
  const worker = await manager.launch(task("input"));
  await until(() => manager.dialogs(worker.id).length === 1);
  assert.equal(events.at(-1).kind, "input");
  assert.equal(worker.status, "working");
  assert.equal(
    traffic(trace).some((event) => event.type === "extension_ui_response"),
    false,
  );
  await assert.rejects(
    manager.send(worker.id, "skip approval", "supervisor"),
    /needs human input/,
  );
  manager.answer(worker.id, {
    type: "extension_ui_response",
    id: "approval-1",
    confirmed: false,
  });
  await until(() => worker.status === "blocked");
  await manager.send(worker.id, "Try again", "supervisor");
  await until(() => manager.dialogs(worker.id).length === 1);
  await manager.stop(worker.id);
  const records = traffic(trace);
  const cancellation = records.findIndex(
    (event) => event.type === "extension_ui_response" && event.cancelled,
  );
  assert.ok(cancellation >= 0);
  assert.equal(records[cancellation + 1].type, "clear_queue");
  assert.throws(
    () =>
      manager.answer(worker.id, {
        type: "extension_ui_response",
        id: "approval-1",
        confirmed: true,
      }),
    /expired or was cancelled/,
  );
});

test("stopped worker resumes the same transcript without replaying instructions", async (t) => {
  const { manager, task, trace, events } = setup(t);
  const worker = await manager.launch(task());
  await until(() => worker.status === "reported");
  const originalId = worker.sessionId;
  await manager.stop(worker.id);
  assert.equal(worker.pid, undefined);
  const restoredStore = new Store(
    dirname(manager.store.directory),
    manager.store.state.parent,
  );
  await manager.close();
  const restored = new Supervisor(restoredStore, {
    command: process.execPath,
    args: [join(dirname(trace), "worker.mjs")],
    env: { ...process.env, FIXTURE_TRACE: trace },
    changed() {},
    event() {},
    timeout: 1_000,
  });
  cleanup(t, () => restored.close());
  restored.enable();
  assert.equal(restored.snapshot()[0].live, false);
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    1,
  );
  await restored.send(worker.id, "An explicit follow-up", "supervisor");
  assert.equal(restored.worker(worker.id).sessionId, originalId);
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    2,
  );
  assert.equal(events.filter((event) => event.kind === "result").length, 1);
});

test("deleted or mismatched transcripts refuse replacement conversations", async (t) => {
  const { manager, task } = setup(t);
  const worker = await manager.launch(task());
  await until(() => worker.status === "reported");
  await manager.stop(worker.id);
  const original = readFileSync(worker.sessionFile, "utf8");
  writeFileSync(
    worker.sessionFile,
    original.replace(worker.sessionId, "changed-id"),
  );
  await assert.rejects(
    manager.send(worker.id, "resume", "supervisor"),
    /identity or project changed/,
  );
  rmSync(worker.sessionFile);
  await assert.rejects(
    manager.send(worker.id, "resume", "supervisor"),
    /transcript is missing/,
  );
});

test("live unknown PID refuses a second writer without signalling that PID", async (t) => {
  const { manager, task } = setup(t);
  manager.enable();
  const worker = manager.store.add(task());
  worker.pid = process.pid;
  await assert.rejects(
    manager.send(worker.id, "resume", "supervisor"),
    /Refusing a second writer/,
  );
  await assert.rejects(manager.stop(worker.id), /Unowned live PID/);
  delete worker.pid; // Only the fixture owns this metadata, never signal the test process.
});

test("parallel dispatch is serialized and capped at two live workers", async (t) => {
  const { manager, task } = setup(t);
  const result = await Promise.allSettled(
    [1, 2, 3].map(() => manager.exclusive(() => manager.launch(task("slow")))),
  );
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 2);
  assert.match(
    result.find((item) => item.status === "rejected").reason.message,
    /At most two/,
  );
  assert.equal(manager.snapshot().length, 2);
});

test("shutdown stops owned processes, releases the lease and never replays work", async (t) => {
  const { manager, task, store, trace } = setup(t);
  const worker = await manager.launch(task("slow"));
  const pid = worker.pid;
  await manager.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(store.lease), false);
  assert.equal(worker.status, "stopped");
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    1,
  );
});

test("disable then enable works in the same parent session", async (t) => {
  const { manager, task } = setup(t);
  await manager.launch(task("slow"));
  await manager.close(true);
  assert.equal(manager.store.state.enabled, false);
  manager.enable();
  assert.equal(manager.store.state.enabled, true);
  const worker = await manager.launch(task());
  await until(() => worker.status === "reported");
});

test("lost prompt acknowledgement stops the worker without an automatic resend", async (t) => {
  const { manager, task, trace } = setup(t, { timeout: 100 });
  await assert.rejects(manager.launch(task("lost-ack")), /outcome is unknown/);
  const worker = manager.snapshot()[0];
  assert.equal(worker.live, false);
  assert.equal(worker.status, "error");
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    1,
  );
});

for (const mode of [
  "wrong-identity",
  "never-ready",
  "malformed",
  "reject",
  "missing-approval",
  "missing-worker",
  "broken-guard",
  "spoofed-guard",
]) {
  test(`${mode} startup/dispatch fails closed and releases the owned process`, async (t) => {
    const { manager, task, trace } = setup(t, { timeout: 150 });
    await assert.rejects(manager.launch(task(mode)));
    assert.equal(manager.snapshot()[0].live, false);
    assert.equal(manager.snapshot()[0].pid, undefined);
    assert.equal(
      traffic(trace).filter((event) => event.type === "prompt").length,
      mode === "reject" ? 1 : 0,
      "No task reaches an unready worker",
    );
  });
}

test("unexpected worker exit emits an error rather than leaving a working session", async (t) => {
  const { manager, task, events } = setup(t);
  await manager.launch(task("crash"));
  await until(() => manager.snapshot()[0].status === "error");
  assert.equal(manager.snapshot()[0].live, false);
  assert.match(events.at(-1).result, /Worker exited/);
});

test("RPC framing preserves split UTF-8 and Unicode line separators", async (t) => {
  const { directory, file } = fixture(t);
  const errors = [];
  const rpc = new WorkerRpc(
    process.execPath,
    [file],
    { cwd: directory, env: { ...process.env, FIXTURE_MODE: "framing" } },
    () => {},
    (error) => errors.push(error),
    1_000,
  );
  cleanup(t, () => rpc.stop());
  const state = await rpc.request({ type: "get_state" });
  assert.equal(state.unicode, "ä\u2028\u2029");
  const requests = await Promise.all([
    rpc.request({ type: "get_state" }),
    rpc.request({ type: "get_messages" }),
  ]);
  assert.equal(requests[0].sessionId, state.sessionId);
  assert.deepEqual(requests[1].messages, []);
  assert.equal(errors.length, 0);
  const stop = rpc.stop();
  assert.equal(rpc.stop(), stop);
  await stop;
});

test("spawn failure rejects pending RPC immediately", async (t) => {
  const directory = temporary(t);
  const rpc = new WorkerRpc(
    join(directory, "does-not-exist"),
    [],
    { cwd: directory, env: process.env },
    () => {},
    () => {},
    1_000,
  );
  await assert.rejects(rpc.request({ type: "get_state" }), /ENOENT/);
  await rpc.stop();
});

test("reports require concrete evidence and UI text strips terminal control sequences", () => {
  assert.equal(
    report({ status: "complete", summary: "done", evidence: [] }),
    undefined,
  );
  assert.equal(
    report({ status: "invented", summary: "done", evidence: ["x"] }),
    undefined,
  );
  assert.ok(
    report({ status: "blocked", summary: "Which file?", evidence: [] }),
  );
  assert.equal(clean("\x1b[31mred\x1b[0m\x07\nline"), "red\nline");
});

async function extensionHarness(t, mode = "tui") {
  const directory = temporary(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  cleanup(t, () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  const loaded = await loadExtensions([join(source, "index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let tools = ["read", "bash", "supervisor"];
  loaded.runtime.getActiveTools = () => tools;
  loaded.runtime.setActiveTools = (names) => {
    tools = names;
  };
  loaded.runtime.getThinkingLevel = () => "high";
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.appendEntry = () => {};
  const state = { notices: [], confirms: [], editor: "", view: undefined };
  const context = {
    cwd: directory,
    mode,
    hasUI: mode === "tui",
    model: { provider: "fixture", id: "model" },
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: SessionManager.inMemory(directory),
    ui: {
      notify: (message) => state.notices.push(message),
      setWidget() {},
      setStatus() {},
      confirm: async (...args) => {
        state.confirms.push(args);
        return false;
      },
    },
  };
  async function emit(type, event = {}) {
    const results = [];
    for (const handler of extension.handlers.get(type) || [])
      results.push(await handler({ type, ...event }, context));
    return results.filter(Boolean);
  }
  cleanup(t, () => emit("session_shutdown"));
  return {
    directory,
    loaded,
    extension,
    context,
    state,
    emit,
    activeTools: () => tools,
  };
}

test("extension factory starts no resources and supervision is off by default", async (t) => {
  const harness = await extensionHarness(t);
  assert.equal(existsSync(join(harness.directory, "supervisor")), false);
  await harness.emit("session_start");
  assert.equal(existsSync(join(harness.directory, "supervisor")), false);
  assert.equal(harness.activeTools().includes("supervisor"), false);
  assert.deepEqual(
    await harness.emit("tool_call", { toolName: "supervisor" }),
    [
      {
        block: true,
        reason:
          "Supervision is off. The user can enable it with /supervisor on.",
      },
    ],
  );
  const tool = harness.extension.tools.get("supervisor").definition;
  assert.equal(tool.exposure, "model-only");
  assert.deepEqual(tool.parameters.properties.action.enum, [
    "launch",
    "send",
    "list",
    "inspect",
    "stop",
  ]);
  assert.equal("confirmed" in tool.parameters.properties, false);
});

test("human enable/off commands do not spawn workers and clear tool exposure", async (t) => {
  const harness = await extensionHarness(t);
  await harness.emit("session_start");
  const command = harness.extension.commands.get("supervisor");
  await command.handler("on", harness.context);
  assert.equal(harness.activeTools().includes("supervisor"), true);
  const tool = harness.extension.tools.get("supervisor").definition;
  const result = await tool.execute(
    "call",
    { action: "list" },
    new AbortController().signal,
    undefined,
    harness.context,
  );
  assert.deepEqual(result.details, []);
  await command.handler("off", harness.context);
  assert.equal(harness.activeTools().includes("supervisor"), false);
});

test("noninteractive parents cannot enable a supervisor", async (t) => {
  const harness = await extensionHarness(t, "print");
  await harness.emit("session_start");
  await harness.extension.commands
    .get("supervisor")
    .handler("on", harness.context);
  assert.equal(harness.activeTools().includes("supervisor"), false);
  assert.equal(existsSync(join(harness.directory, "supervisor")), false);
});

test("worker guard prevents nested delegation and requires evidence", async (t) => {
  const directory = temporary(t);
  const oldWorker = process.env.PI_SUPERVISOR_WORKER;
  const oldContract = process.env.PI_SUPERVISOR_CONTRACT;
  process.env.PI_SUPERVISOR_WORKER = "1";
  process.env.PI_SUPERVISOR_CONTRACT = JSON.stringify({
    objective: "read files",
    scope: "test.ts",
    acceptance: "cite lines",
  });
  cleanup(t, () => {
    if (oldWorker === undefined) delete process.env.PI_SUPERVISOR_WORKER;
    else process.env.PI_SUPERVISOR_WORKER = oldWorker;
    if (oldContract === undefined) delete process.env.PI_SUPERVISOR_CONTRACT;
    else process.env.PI_SUPERVISOR_CONTRACT = oldContract;
  });
  const loaded = await loadExtensions(
    [join(source, "index.ts"), join(source, "worker.ts")],
    directory,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions[0].tools.size, 0);
  const worker = loaded.extensions[1];
  for (const handler of worker.handlers.get("session_start") || [])
    await handler({}, {});
  assert.equal(worker.commands.has("pi-extensions-worker-ready-v1"), false);
  const unguardedRead = await worker.handlers.get("tool_call")[0](
    { toolName: "read" },
    {},
  );
  assert.equal(
    unguardedRead.block,
    true,
    "Even read tools fail closed without approval registration",
  );
  loaded.runtime.getActiveTools = () => [
    "read",
    "supervisor",
    "subagent",
    "worker_report",
  ];
  loaded.runtime.setActiveTools = (names) => {
    assert.deepEqual(names, ["read", "worker_report"]);
  };
  const event = { systemPromptOptions: { cwd: directory, sections: {} } };
  await worker.handlers.get("before_agent_start")[0](event, {});
  assert.match(buildSystemPrompt(event.systemPromptOptions), /read files/);
  for (const name of ["supervisor", "subagent"]) {
    const result = await worker.handlers.get("tool_call")[0](
      { toolName: name },
      {},
    );
    assert.equal(result.block, true);
  }
  const tool = worker.tools.get("worker_report").definition;
  await assert.rejects(
    tool.execute("report", {
      status: "complete",
      summary: "done",
      evidence: [],
    }),
    /concrete evidence/,
  );
  const result = await tool.execute("report", {
    status: "complete",
    summary: "done",
    evidence: ["test.ts:42 passed"],
  });
  assert.equal(result.details.status, "complete");
});

test("reacquiring a lease reloads persisted workers and human ownership", (t) => {
  const directory = temporary(t);
  const first = new Store(directory, "parent");
  const second = new Store(directory, "parent");
  first.acquire();
  first.save();
  first.release();
  second.acquire();
  const worker = second.add({
    name: "Worker",
    objective: "Read",
    scope: "test.ts",
    acceptance: "Cite lines",
    cwd: directory,
  });
  worker.owner = "human";
  second.save();
  second.release();
  first.acquire();
  first.save();
  assert.equal(first.state.workers[0].owner, "human");
  assert.equal(first.state.workers[0].id, worker.id);
  first.release();
});

test("worker arguments preserve denied project trust without automatically elevating trust", () => {
  const context = {
    model: { provider: "fixture", id: "test-model" },
    isProjectTrusted: () => false,
  };
  const args = workerArgs(context, "high");
  assert.ok(args.includes("--no-approve"));
  assert.equal(args.includes("--approve"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(
    workerArgs({ ...context, isProjectTrusted: () => true }, "high").includes(
      "--no-approve",
    ),
    false,
  );
});

test("timed child dialogs expire and do not block future instructions", async (t) => {
  const { manager, task } = setup(t);
  const worker = await manager.launch(task("timed-input"));
  await until(() => manager.dialogs(worker.id).length === 1);
  await until(() => manager.dialogs(worker.id).length === 0);
  assert.throws(
    () =>
      manager.answer(worker.id, {
        type: "extension_ui_response",
        id: "approval-1",
        confirmed: true,
      }),
    /expired/,
  );
  await until(() => worker.status === "blocked");
  await manager.send(worker.id, "Another explicit instruction", "supervisor");
  await until(() => worker.status === "blocked");
});

async function controllerHarness(t, options = {}) {
  const { directory: temporaryDirectory, file } = fixture(t);
  const directory = options.directory || temporaryDirectory;
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  cleanup(t, () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const state = {
    idle: true,
    activeTools: ["read"],
    messages: [],
    notices: [],
    manager: undefined,
  };
  const pi = {
    on(type, handler) {
      handlers.set(type, [...(handlers.get(type) || []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerFlag() {},
    getFlag: () => options.flag === true,
    getActiveTools: () => state.activeTools,
    setActiveTools(names) {
      state.activeTools = names;
    },
    getThinkingLevel: () => "high",
    sendMessage(message, delivery) {
      state.messages.push({ message, delivery });
    },
    events: createEventBus(),
    getAllTools: () => [],
    appendEntry: (name, data) =>
      context.sessionManager.appendCustomEntry(name, data),
  };
  await supervisorExtension(pi, (store, config) => {
    state.manager = new Supervisor(store, {
      ...config,
      command: process.execPath,
      args: [file],
      timeout: 1_000,
    });
    return state.manager;
  });
  const context = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    model: { provider: "fixture", id: "model" },
    isIdle: () => state.idle,
    isProjectTrusted: () => true,
    sessionManager: options.parent || SessionManager.inMemory(directory),
    ui: {
      notify(message) {
        state.notices.push(message);
      },
      setWidget() {},
      setStatus() {},
      editor: async () => undefined,
    },
  };
  async function emit(type, event = {}) {
    for (const handler of handlers.get(type) || [])
      await handler({ type, ...event }, context);
  }
  cleanup(t, () => emit("session_shutdown"));
  await emit("session_start", { reason: options.reason || "startup" });
  return { directory, context, state, emit, commands, tools };
}

for (const aborted of [false, true])
  test(`results are delivered once after parent settlement (aborted=${aborted}) without restarting an aborted parent`, async (t) => {
    const harness = await controllerHarness(t);
    await harness.commands.get("supervisor").handler("on", harness.context);
    harness.state.idle = false;
    const result = await harness.tools.get("supervisor").execute(
      "launch",
      {
        action: "launch",
        name: "Check",
        objective: "complete",
        scope: "read only",
        acceptance: "evidence",
      },
      new AbortController().signal,
      undefined,
      harness.context,
    );
    await until(
      () =>
        harness.state.manager.worker(result.details.id).status === "reported",
    );
    assert.equal(
      harness.state.messages.length,
      0,
      "No notification enters the parent's disposable follow-up queue",
    );
    await harness.emit("agent_settled", { aborted });
    assert.equal(harness.state.messages.length, 1);
    assert.equal(harness.state.messages[0].delivery.triggerTurn, !aborted);
    assert.equal(harness.state.messages[0].delivery.deliverAs, undefined);
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(harness.state.messages.length, 1);
  });

test("pending human editor cannot hold worker shutdown in the mutation queue", async (t) => {
  const harness = await controllerHarness(t);
  const command = harness.commands.get("supervisor");
  await command.handler("on", harness.context);
  const worker = await harness.state.manager.launch({
    name: "Check",
    objective: "slow",
    scope: "read only",
    acceptance: "evidence",
    cwd: harness.directory,
  });
  await harness.state.manager.take(worker.id);
  let finishEditor;
  harness.context.ui.editor = () =>
    new Promise((resolve) => {
      finishEditor = resolve;
    });
  const pending = command.handler(`send ${worker.id}`, harness.context);
  await until(() => finishEditor !== undefined);
  let closed = false;
  const closing = harness.emit("session_shutdown").then(() => {
    closed = true;
  });
  await until(() => closed, "shutdown while editor is open");
  assert.equal(harness.state.manager.snapshot()[0].live, false);
  finishEditor("This instruction must not be sent after shutdown");
  await pending;
  await closing;
  assert.match(harness.state.notices.at(-1), /not available/);
});

test("reload honors explicit off even when the startup supervise flag remains true", async (t) => {
  const first = await controllerHarness(t, { flag: true });
  assert.equal(first.state.manager.store.state.enabled, true);
  await first.commands.get("supervisor").handler("off", first.context);
  await first.emit("session_shutdown");
  const second = await controllerHarness(t, {
    flag: true,
    reason: "reload",
    directory: first.directory,
    parent: first.context.sessionManager,
  });
  assert.equal(second.state.manager.store.state.enabled, false);
  assert.equal(second.state.activeTools.includes("supervisor"), false);
});

test("in-flight instructions cannot be relabelled by an earlier settlement", async (t) => {
  const { manager, task, trace } = setup(t);
  const worker = await manager.launch(task("slow"));
  const original = worker.lastInstruction;
  await assert.rejects(
    manager.send(worker.id, "New instruction", "supervisor"),
    /still running/,
  );
  assert.equal(worker.lastInstruction, original);
  assert.equal(
    traffic(trace).filter((event) => event.type === "prompt").length,
    1,
  );
});

test("the model cannot stop a worker under human control", async (t) => {
  const harness = await controllerHarness(t);
  await harness.commands.get("supervisor").handler("on", harness.context);
  const worker = await harness.state.manager.launch({
    name: "Check",
    objective: "slow",
    scope: "read only",
    acceptance: "evidence",
    cwd: harness.directory,
  });
  await harness.state.manager.take(worker.id);
  await assert.rejects(
    harness.tools
      .get("supervisor")
      .execute(
        "stop",
        { action: "stop", id: worker.id },
        new AbortController().signal,
        undefined,
        harness.context,
      ),
    /Human control is active/,
  );
  assert.equal(harness.state.manager.snapshot()[0].live, true);
});

test("transcript inspector fits narrow terminals and returns on cancellation", async (t) => {
  const harness = await controllerHarness(t);
  const command = harness.commands.get("supervisor");
  await command.handler("on", harness.context);
  const worker = await harness.state.manager.launch({
    name: "Check",
    objective: "complete",
    scope: "read only",
    acceptance: "evidence",
    cwd: harness.directory,
  });
  await until(() => worker.status === "reported");
  let view;
  const terminal = { rows: 20 };
  harness.context.ui.custom = (factory) =>
    new Promise((done) => {
      view = factory(
        { terminal, requestRender() {} },
        getThemeByName("dark"),
        getKeybindings(),
        done,
      );
    });
  const pending = command.handler(`inspect ${worker.id}`, harness.context);
  await until(() => view !== undefined);
  for (const rows of [1, 3, 20]) {
    terminal.rows = rows;
    for (const width of [5, 20, 80]) {
      view.invalidate();
      const lines = view.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      view.handleInput("\u001b[B");
    }
  }
  view.handleInput("\u001b");
  await pending;
});

test("real Pi manager launches the actual worker and approval guards without a model", async (t) => {
  const directory = temporary(t);
  const fixture = join(directory, "intercept.ts");
  writeFileSync(
    fixture,
    `export default function(pi) {
    pi.on('input', (event, ctx) => {
      ctx.sessionManager.appendMessage({role:'user', content:event.text, timestamp:Date.now()});
      return {action:'handled'};
    });
  }`,
  );
  const manager = new Supervisor(
    new Store(join(directory, "private"), "actual-worker-parent"),
    {
      command: process.execPath,
      args: [
        join(packageDir, "dist/cli.js"),
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--no-approve",
        "-e",
        join(source, "worker.ts"),
        "-e",
        join(root, "extensions/approval/index.ts"),
        "-e",
        fixture,
      ],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: directory,
        PI_OFFLINE: "1",
        PI_NOTIFY: "0",
      },
      changed() {},
      event() {},
      timeout: 15_000,
    },
  );
  cleanup(t, () => manager.close());
  const worker = await manager.launch({
    name: "Actual worker",
    objective: "Read a fixture",
    scope: "read only",
    acceptance: "No model calls",
    cwd: directory,
  });
  assert.equal(worker.status, "needs-review");
  const id = worker.sessionId;
  assert.ok(existsSync(worker.sessionFile));
  await manager.stop(worker.id);
  await manager.send(
    worker.id,
    "Explicit follow-up without a model",
    "supervisor",
  );
  assert.equal(worker.sessionId, id);
  await manager.stop(worker.id);
  assert.match(await manager.inspect(worker.id), /Explicit follow-up/);
});

test("real Pi RPC handles readiness, human confirmation and persisted identity without a model", async (t) => {
  const directory = temporary(t);
  const fixture = join(directory, "fixture.ts");
  const sessionFile = join(directory, "session.jsonl");
  writeFileSync(
    fixture,
    `export default function(pi) {
    pi.registerCommand('fixture-confirm', {description:'fixture', handler:async (_args, ctx) => {
      const allowed = await ctx.ui.confirm('Publish fixture?', 'No external action is performed.');
      pi.appendEntry('fixture-answer', {allowed});
    }});
    pi.registerCommand('fixture-write', {description:'fixture', handler:async (_args, ctx) => {
      ctx.sessionManager.appendMessage({role:'user', content:'fixture persistence only', timestamp:Date.now()});
    }});
  }`,
  );
  const events = [];
  let rpc;
  rpc = new WorkerRpc(
    process.execPath,
    [
      join(packageDir, "dist/cli.js"),
      "--mode",
      "rpc",
      "--session",
      sessionFile,
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--no-approve",
      "-e",
      fixture,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: directory,
        PI_OFFLINE: "1",
        PI_NOTIFY: "0",
      },
    },
    (event) => {
      events.push(event);
      if (event.type === "extension_ui_request")
        rpc.reply({
          type: "extension_ui_response",
          id: event.id,
          confirmed: false,
        });
    },
    () => {},
    15_000,
  );
  cleanup(t, () => rpc.stop());
  const first = await rpc.request({ type: "get_state" });
  assert.equal(first.sessionFile, sessionFile);
  assert.equal(existsSync(sessionFile), false);
  assert.equal(
    (await rpc.request({ type: "prompt", message: "/fixture-confirm" }))
      .disposition,
    "handled",
  );
  assert.equal(
    events.filter((event) => event.type === "extension_ui_request").length,
    1,
  );
  await rpc.request({ type: "prompt", message: "/fixture-write" });
  const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
  assert.equal(header.id, first.sessionId);
  assert.match(readFileSync(sessionFile, "utf8"), /fixture persistence only/);
  await rpc.stop();
});

test("workers always select bundled approval, never an arbitrary user installation", async (t) => {
  const harness = await extensionHarness(t);
  const arbitrary = join(harness.directory, "extensions/approval/index.ts");
  mkdirSync(dirname(arbitrary), { recursive: true });
  writeFileSync(
    arbitrary,
    "export default function() { throw Error('must not load'); }\n",
  );
  const args = workerArgs(harness.context, "high");
  assert.ok(args.includes(join(root, "extensions/approval/index.ts")));
  assert.equal(args.includes(arbitrary), false);
  for (const [flag, value] of [
    ["--provider", "fixture"],
    ["--model", "model"],
    ["--thinking", "high"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
});

for (const missing of ["approval", "worker", "broken-config"])
  test(`real Pi refuses first task with ${missing} guard failure without a model`, async (t) => {
    const directory = temporary(t);
    const config = join(directory, "config.json");
    writeFileSync(config, missing === "broken-config" ? "invalid json" : "{}");
    const intercept = join(directory, "intercept.ts");
    writeFileSync(
      intercept,
      `export default function(pi) {
      pi.on('input', (event, ctx) => {
        ctx.sessionManager.appendMessage({role:'user', content:event.text, timestamp:Date.now()});
        return {action:'handled'};
      });
    }`,
    );
    const manager = new Supervisor(
      new Store(join(directory, "private"), "guard-failure-parent"),
      {
        command: process.execPath,
        args: [
          join(packageDir, "dist/cli.js"),
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-mcp",
          "--no-approve",
          ...(missing === "worker" ? [] : ["-e", join(source, "worker.ts")]),
          ...(missing === "approval"
            ? []
            : ["-e", join(root, "extensions/approval/index.ts")]),
          "-e",
          intercept,
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: directory,
          PI_EXTENSIONS_CONFIG: config,
          PI_OFFLINE: "1",
          PI_NOTIFY: "0",
        },
        changed() {},
        event() {},
        timeout: 15_000,
      },
    );
    cleanup(t, () => manager.close());
    await assert.rejects(
      manager.launch({
        name: "Check guards",
        objective: "No task may run",
        scope: "fixture only",
        acceptance: "Refuse before dispatch",
        cwd: directory,
      }),
      /readiness failed/,
    );
    const worker = manager.snapshot()[0];
    assert.equal(worker.live, false);
    assert.equal(worker.pid, undefined);
    assert.equal(worker.status, "error");
    assert.equal(worker.lastInstruction, "");
    assert.equal(
      existsSync(worker.sessionFile),
      false,
      "No task was dispatched or persisted",
    );
  });
