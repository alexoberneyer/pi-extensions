import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extensions/agents");
const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const { createJiti } = createRequire(join(packageDir, "package.json"))("jiti");
const { WebSocketServer } = createRequire(join(root, "package.json"))("ws");
const jiti = createJiti(import.meta.url);
const { claudeRows, createClaudeAdapter } = await jiti.import(
  join(source, "claude.ts"),
);
const { codexRow, createCodexAdapter } = await jiti.import(
  join(source, "codex.ts"),
);
const { ExternalSessions, shellQuote } = await jiti.import(
  join(source, "external.ts"),
);

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "agents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function env(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function thread(overrides = {}) {
  return {
    id: "thread-a",
    name: "Codex fixture",
    preview: "Initial prompt",
    cwd: "/project",
    status: { type: "idle" },
    updatedAt: 100,
    model: "fixture-model",
    ...overrides,
  };
}

async function tick() {
  await new Promise((done) => setImmediate(done));
}

async function daemon(t, respond) {
  const directory = temporary(t);
  const socket = join(directory, "sock ' :"); // Exercise paths that cannot be interpolated into a URL.
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests = [];
  wss.on("connection", (client) => {
    client.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      if (message.method === "initialized") return;
      const result = await respond(message, client);
      if (result !== undefined && client.readyState === 1)
        client.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(socket, done);
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((done) => server.close(done));
  });
  return { socket, requests, wss };
}

test("Claude uses live status before background job state", () => {
  const rows = claudeRows([
    {
      sessionId: "a",
      cwd: "/project",
      kind: "background",
      pid: 123,
      status: "idle",
      state: "done",
      name: "Done job",
    },
    {
      sessionId: "b",
      cwd: "/project",
      kind: "interactive",
      pid: 456,
      status: "busy",
    },
    {
      sessionId: "c",
      cwd: "/project",
      kind: "background",
      status: "waiting",
      waitingFor: "Approve?",
    },
    { sessionId: "d", cwd: "/project", kind: "background", state: "blocked" },
    { sessionId: "e", cwd: "/project", status: "new-version-status" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["ready", "working", "waiting", "waiting", "unknown"],
  );
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[1].pid, 456);
  assert.equal(rows[0].updated, 0, "polling is not activity");
  assert.equal(
    rows[1].nativeCommand,
    undefined,
    "do not duplicate a live foreground conversation",
  );
  assert.equal(rows[2].preview, "Approve?");
  assert.equal(rows[3].live, false);
  assert.match(rows[3].detail, /No live PID/);
  assert.equal(rows[0].source, "claude");
  assert.equal(rows[0].sessionFile, undefined);
});

test("Claude exposes only validated native PIDs and meaningful unnamed project titles", () => {
  for (const pid of [
    undefined,
    null,
    "123",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const [row] = claudeRows([
      { sessionId: "opaque-native-id", cwd: "/work/project", pid },
    ]);
    assert.equal(row.pid, undefined);
    assert.equal(row.live, false);
    assert.equal(row.title, "Claude in project");
    assert.match(row.detail, /No live PID/);
  }
  for (const name of [undefined, "", "   ", "\x1b[31m"]) {
    const [row] = claudeRows([
      { sessionId: "opaque-id", cwd: "/work/project/", pid: 73238, name },
    ]);
    assert.equal(row.pid, 73238);
    assert.equal(row.live, true);
    assert.equal(row.title, "Claude in project");
  }
  const [remote] = claudeRows(
    [{ sessionId: "remote", cwd: "/srv/project", pid: 123 }],
    undefined,
    true,
  );
  assert.equal(remote.pid, 123);
  assert.equal(remote.cwd, "/srv/project");
  assert.equal(remote.title, "Claude in project");
});

test("Claude commands use the original cwd and config directory with safe shell quoting", () => {
  const cwd = "/project/O'Brien $(touch /tmp/not-executed)";
  const [row] = claudeRows(
    [{ sessionId: "session-a", id: "abc123", cwd, kind: "background" }],
    "/custom/claude's config",
  );
  assert.equal(
    row.nativeCommand,
    `cd -- ${shellQuote(cwd)} && CLAUDE_CONFIG_DIR=${shellQuote("/custom/claude's config")} claude attach 'abc123'`,
  );
  assert.equal(
    execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(cwd)}`], {
      encoding: "utf8",
    }),
    cwd,
  );
  const [unsafe] = claudeRows([
    { sessionId: "a", cwd: "/project/\nunsafe", kind: "background" },
  ]);
  assert.equal(unsafe.nativeCommand, undefined);
  assert.throws(() => shellQuote("\x1b]52;evil"));
});

test("Claude validates schema, namespaces and deduplicates identities, sanitizes previews", () => {
  assert.throws(() => claudeRows({ sessions: [] }));
  assert.throws(() =>
    claudeRows([{ sessionId: "bad; command", cwd: "/project" }]),
  );
  assert.deepEqual(claudeRows([]), []);
  const rows = claudeRows([
    null,
    { sessionId: "a", cwd: "/project", name: "Old" },
    {
      sessionId: "a",
      cwd: "/project",
      name: "Title\x1b[31m",
      waitingFor: "Input\x1b]52;c;secret\x07",
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "claude:a");
  assert.equal(rows[0].title, "Title");
  assert.equal(rows[0].preview, "Input");
});

test("Claude adapter invokes only agents --json and honors cancellation", async (t) => {
  const bin = temporary(t);
  env(t, "PATH", bin);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["agents","--json"]') process.exit(1);\nconsole.log('[]');\n`,
    { mode: 0o700 },
  );
  assert.deepEqual(
    await createClaudeAdapter().list(AbortSignal.timeout(2000)),
    [],
  );
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    createClaudeAdapter().list(AbortSignal.timeout(100)),
    /abort/i,
  );
});

test("Codex maps native runtime flags and never treats load state as process ownership", () => {
  for (const [runtime, expected] of [
    [{ type: "idle" }, "ready"],
    [{ type: "active", activeFlags: [] }, "working"],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "waiting"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "waiting"],
    [{ type: "systemError" }, "error"],
    [{ type: "future-status" }, "unknown"],
    [{ type: "active" }, "unknown"],
    [{ type: "active", activeFlags: ["future-flag"] }, "unknown"],
  ]) {
    const row = codexRow(thread({ status: runtime }), "/tmp/codex.sock");
    assert.equal(row.status, expected);
    assert.equal(row.key, "codex:thread-a");
    assert.deepEqual(row.owners, []);
    assert.equal(row.sessionFile, undefined);
    assert.equal(row.updated, 100_000);
    assert.match(
      row.nativeCommand,
      /codex resume --remote 'unix:\/\/\/tmp\/codex.sock' 'thread-a'/,
    );
  }
  assert.equal(
    codexRow(thread({ status: { type: "notLoaded" } }), "/tmp/sock"),
    undefined,
  );
  assert.throws(() => codexRow({ id: "a" }, "/tmp/sock"));
});

test("Codex only reads loaded threads, follows pages, deduplicates and ignores requests", async (t) => {
  const fixture = await daemon(t, (message, client) => {
    if (message.method === "initialize") return {};
    if (message.method === "thread/loaded/list")
      return message.params.cursor
        ? { data: ["thread-a", "thread-b"], nextCursor: null }
        : { data: ["thread-a"], nextCursor: "page2" };
    assert.equal(message.method, "thread/read");
    assert.equal(message.params.includeTurns, false);
    client.send(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: "approval-id",
        params: {},
      }),
    );
    return { thread: thread({ id: message.params.threadId }) };
  });
  const rows = await createCodexAdapter(fixture.socket).list(
    AbortSignal.timeout(3000),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((r) => r.key)),
    new Set(["codex:thread-a", "codex:thread-b"]),
  );
  assert.deepEqual(
    fixture.requests.map((r) => r.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/loaded/list",
      "thread/read",
      "thread/read",
    ],
  );
  await tick();
});

test("Codex never starts a missing daemon and respects CODEX_HOME", async (t) => {
  env(t, "CODEX_HOME", temporary(t));
  await assert.rejects(
    createCodexAdapter().list(AbortSignal.timeout(1000)),
    /unavailable|closed/,
  );
});

test("Codex rejects repeated pagination cursors", async (t) => {
  const fixture = await daemon(t, (message) => {
    if (message.method === "initialize") return {};
    return { data: ["thread-a"], nextCursor: "same" };
  });
  await assert.rejects(
    createCodexAdapter(fixture.socket).list(AbortSignal.timeout(2000)),
    /Repeated Codex cursor/,
  );
});

test("Codex rejects malformed messages without exposing response contents", async (t) => {
  const fixture = await daemon(t, (_message, client) => {
    client.send("secret non-JSON response");
  });
  await assert.rejects(
    createCodexAdapter(fixture.socket).list(AbortSignal.timeout(2000)),
    /^Error: Invalid Codex response$/,
  );
});

test("Codex rejects mismatched thread identities", async (t) => {
  const fixture = await daemon(t, (message) => {
    if (message.method === "initialize") return {};
    if (message.method === "thread/loaded/list")
      return { data: ["thread-a"], nextCursor: null };
    return { thread: thread({ id: "wrong-thread" }) };
  });
  await assert.rejects(
    createCodexAdapter(fixture.socket).list(AbortSignal.timeout(2000)),
    /identity mismatch/,
  );
});

test("Codex request timeout and dashboard cancellation close the socket", async (t) => {
  const fixture = await daemon(t, () => undefined);
  const controller = new AbortController();
  const listing = createCodexAdapter(fixture.socket).list(controller.signal);
  for (let i = 0; i < 100 && !fixture.requests.length; i++) await tick();
  controller.abort();
  await assert.rejects(listing, /cancelled|abort/i);
  for (let i = 0; i < 100 && fixture.wss.clients.size; i++) await tick();
  assert.equal(fixture.wss.clients.size, 0);
  await assert.rejects(
    createCodexAdapter(fixture.socket).list(AbortSignal.timeout(100)),
    /cancelled/,
  );
});

test("one unavailable source retains Unknown rows without hiding healthy sources", async (t) => {
  let fail = false;
  let changed = 0;
  const sessions = new ExternalSessions(
    [
      {
        source: "claude",
        list: async () => {
          if (fail) throw new Error("secret error payload must not appear");
          return claudeRows([
            {
              sessionId: "a",
              cwd: "/project",
              kind: "background",
              status: "busy",
              pid: 123,
            },
          ]);
        },
      },
      { source: "codex", list: async () => [codexRow(thread(), "/tmp/sock")] },
    ],
    () => changed++,
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  assert.equal(sessions.rows.length, 2);
  fail = true;
  sessions.refresh();
  await tick();
  assert.equal(
    sessions.rows.find((r) => r.source === "claude").status,
    "unknown",
  );
  assert.equal(
    sessions.rows.find((r) => r.source === "claude").nativeCommand,
    undefined,
  );
  assert.equal(sessions.rows.find((r) => r.source === "claude").live, false);
  assert.equal(sessions.rows.find((r) => r.source === "codex").status, "ready");
  assert.match(sessions.summary, /Claude unavailable/);
  assert.doesNotMatch(sessions.summary, /secret/);
  assert.ok(changed >= 4);
  fail = false;
  sessions.refresh();
  await tick();
  assert.equal(
    sessions.rows.find((r) => r.source === "claude").status,
    "working",
  );
});

test("successful empty discovery clears previously seen sessions", async (t) => {
  let rows = [codexRow(thread(), "/tmp/sock")];
  const sessions = new ExternalSessions(
    [{ source: "codex", list: async () => rows }],
    () => {},
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  assert.equal(sessions.rows.length, 1);
  rows = [];
  sessions.refresh();
  await tick();
  assert.deepEqual(sessions.rows, []);
  assert.equal(sessions.summary, "Codex 0");
});

test("polls do not overlap, and closing ignores late results", async () => {
  let finish;
  let calls = 0;
  let changed = 0;
  let signal;
  const sessions = new ExternalSessions(
    [
      {
        source: "claude",
        list: (s) => {
          calls++;
          signal = s;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    ],
    () => changed++,
  );
  sessions.start();
  sessions.refresh();
  assert.equal(calls, 1);
  sessions.dispose();
  sessions.dispose();
  assert.equal(signal.aborted, true);
  finish([]);
  await tick();
  assert.equal(changed, 0);
  sessions.refresh();
  assert.equal(calls, 1);
});
