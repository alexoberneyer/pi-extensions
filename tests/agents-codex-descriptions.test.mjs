import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const { createJiti } = createRequire(join(packageDir, "package.json"))("jiti");
const { WebSocketServer } = createRequire(join(root, "package.json"))("ws");
const jiti = createJiti(import.meta.url);
const { codexRow, createCodexAdapter, enrichCodexRow } = await jiti.import(
  join(root, "extensions/agents/codex.ts"),
);
const { DescriptionReader } = await jiti.import(
  join(root, "extensions/agents/descriptions.ts"),
);

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "cxd-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function thread(overrides = {}) {
  return {
    id: "thread-a",
    sessionId: "session-a",
    cwd: "/work/shipping",
    name: "Shipping repair",
    preview: "Fix shipment validation",
    status: { type: "active", activeFlags: [] },
    updatedAt: 100,
    model: "fixture-model",
    ...overrides,
  };
}

function record(type, payload) {
  return { type, payload };
}

function meta(native, overrides = {}) {
  return record("session_meta", {
    id: native.id,
    cwd: native.cwd,
    base_instructions: { text: "PRIVATE base instructions" },
    ...overrides,
  });
}

function message(role, text, overrides = {}) {
  return record("response_item", {
    type: "message",
    role,
    content: [
      { type: role === "assistant" ? "output_text" : "input_text", text },
    ],
    ...overrides,
  });
}

function event(type, text) {
  return record("event_msg", { type, message: text });
}

function question(args, name = "request_user_input") {
  return record("response_item", {
    type: "function_call",
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  });
}

function jsonl(records) {
  return `${records.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function rollout(t, native, records, directory = "sessions") {
  const home = temporary(t);
  mkdirSync(join(home, directory), { recursive: true });
  const path = join(home, directory, "rollout.jsonl");
  writeFileSync(path, jsonl(records));
  return { home, native: { ...native, path }, path };
}

async function describe(native, home, reader = new DescriptionReader()) {
  const before = codexRow(native, "/tmp/codex.sock");
  const row = await enrichCodexRow(
    native,
    before,
    reader,
    home,
    AbortSignal.timeout(3000),
  );
  const { title: _oldTitle, preview: _oldPreview, ...oldState } = before;
  const { title: _title, preview: _preview, ...state } = row;
  assert.deepEqual(state, oldState, "only title and preview may be enriched");
  return row;
}

test("Codex prefers a sanitized meaningful native title and exposes nativeId", () => {
  const row = codexRow(
    thread({ name: " \x1b[31m Repair\n\tshipping\x1b[0m \u202e " }),
    "/tmp/codex.sock",
  );
  assert.equal(row.title, "Repair shipping");
  assert.equal(row.preview, "Fix shipment validation");
  assert.equal(row.nativeId, "thread-a");
  assert.equal(row.key, "codex:thread-a");
  assert.equal(row.live, true);
  assert.equal(row.status, "working");
  assert.equal(row.updated, 100_000);
  assert.deepEqual(row.owners, []);
  assert.equal(row.pid, undefined);
  assert.equal(row.sessionFile, undefined);
  assert.equal(
    codexRow(
      thread({ name: "Meaningful native title ".repeat(20) }),
      "/tmp/sock",
    ).title.length,
    160,
  );
});

test("Codex rejects hashes, repeated native IDs, empty and control-only titles", () => {
  for (const name of [
    "thread-a",
    "thread-a thread-a",
    "session-a",
    "session-a session-a",
    "01955c67-df44-7c68-9472-e73d49d5841a",
    "a3".repeat(32),
    "",
    "  \n\t ",
    "\x1b[31m\x00\u202e",
    null,
    undefined,
  ]) {
    const row = codexRow(thread({ name }), "/tmp/sock");
    assert.equal(row.title, "Fix shipment validation", JSON.stringify(name));
  }
  const row = codexRow(
    thread({ name: "thread-a", preview: "  Check\n address\tvalidation  " }),
    "/tmp/sock",
  );
  assert.equal(row.title, "Check address validation");
  assert.equal(row.preview, "Check address validation");
});

test("Codex does not label unavailable or unreadable task metadata as a new session", () => {
  for (const preview of [
    undefined,
    null,
    "",
    " \t",
    "\x1b[31m",
    "thread-a thread-a",
    "f".repeat(64),
  ]) {
    const row = codexRow(
      thread({ name: null, preview, turns: [] }),
      "/tmp/sock",
    );
    assert.equal(row.title, "Codex in shipping");
    assert.equal(row.preview, "");
  }
  const row = codexRow(
    thread({
      name: "",
      preview:
        "<environment_context>PRIVATE cwd and settings</environment_context>",
    }),
    "/tmp/sock",
  );
  assert.equal(row.title, "Codex in shipping");
  assert.equal(row.preview, "");
});

test("trusted short rollouts provide recent user/assistant text, never private context", async (t) => {
  const native = thread();
  const fixture = rollout(t, native, [
    meta(native),
    message("system", "PRIVATE system"),
    message("developer", "PRIVATE developer"),
    message(
      "user",
      "# AGENTS.md instructions for /work/shipping\n<INSTRUCTIONS>PRIVATE AGENTS instructions</INSTRUCTIONS>",
    ),
    message(
      "user",
      "<environment_context>PRIVATE environment</environment_context>",
    ),
    message("user", "Fix shipment validation"),
    message("assistant", "Validation is fixed.", { channel: "final" }),
    event("user_message", "Please add a regression test."),
    event(
      "agent_message",
      "Regression\n test added.\x1b]52;c;PRIVATE clipboard\x07",
    ),
    message("assistant", "PRIVATE reasoning", { channel: "analysis" }),
    record("response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "PRIVATE summary" }],
    }),
    record("response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: "PRIVATE tool args",
    }),
    record("response_item", {
      type: "function_call_output",
      output: "PRIVATE tool output",
    }),
    message("tool", "PRIVATE tool message"),
    message("assistant", "PRIVATE tool recipient", {
      recipient: "functions.exec_command",
    }),
    event("agent_reasoning", "PRIVATE event reasoning"),
    event("token_count", "PRIVATE token data"),
  ]);
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.title, "Shipping repair");
  assert.equal(row.preview, "Regression test added.");
  assert.doesNotMatch(row.preview, /PRIVATE|instructions|environment/);
  assert.doesNotMatch(row.detail, /Preview is the initial prompt/);
});

test("Codex falls back to the first real user prompt in the head, not recent text", async (t) => {
  const native = thread({ name: "thread-a thread-a", preview: undefined });
  const fixture = rollout(t, native, [
    meta(native),
    message(
      "user",
      "# AGENTS.md instructions for /work/shipping\n<INSTRUCTIONS>PRIVATE instructions</INSTRUCTIONS>",
    ),
    message(
      "user",
      "<environment_context>PRIVATE context</environment_context>",
    ),
    message("assistant", "Previous assistant context"),
    message("user", "  Repair\n invoice totals.  "),
    event("user_message", "Then check rounding."),
    message("assistant", "Rounding is now covered.", { channel: "final" }),
  ]);
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.title, "Repair invoice totals.");
  assert.equal(row.preview, "Rounding is now covered.");
});

test("context wrappers can share a block with real user text without becoming the title", async (t) => {
  const native = thread({ name: "", preview: undefined });
  const fixture = rollout(t, native, [
    meta(native),
    message(
      "user",
      "# AGENTS.md instructions for /work/shipping\n<INSTRUCTIONS>PRIVATE first instructions</INSTRUCTIONS>\n# AGENTS.md instructions for /work\n<INSTRUCTIONS>PRIVATE second instructions</INSTRUCTIONS>\n<environment_context>PRIVATE environment</environment_context>\nRepair the invoice parser.",
    ),
    event("agent_message", "Invoice parser repaired."),
    event("user_message", "Please check the edge cases."),
  ]);
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.title, "Repair the invoice parser.");
  assert.equal(row.preview, "Please check the edge cases.");
});

test("native names and initial prompts stay stable as recent text changes", async (t) => {
  const native = thread({ name: "" });
  const fixture = rollout(t, native, [
    meta(native),
    event("user_message", native.preview),
    event("agent_message", "First progress report"),
  ]);
  const reader = new DescriptionReader();
  const first = await describe(fixture.native, fixture.home, reader);
  writeFileSync(
    fixture.path,
    jsonl([
      meta(native),
      event("user_message", native.preview),
      event("agent_message", "A newer, longer progress report"),
    ]),
  );
  const second = await describe(fixture.native, fixture.home, reader);
  assert.equal(first.title, "Fix shipment validation");
  assert.equal(second.title, first.title);
  assert.equal(second.preview, "A newer, longer progress report");
  const named = await describe(
    { ...fixture.native, name: "Native chosen title" },
    fixture.home,
    reader,
  );
  assert.equal(named.title, "Native chosen title");
});

test("large rollouts read bounded edges, skip incomplete lines and ignore middle-only text", async (t) => {
  const native = thread({ name: "", preview: undefined });
  const fixture = rollout(t, native, []);
  const head = jsonl([
    meta(native),
    event("user_message", "Repair shipment validation"),
  ]);
  const filler = jsonl([
    record("response_item", {
      type: "function_call_output",
      output: "PRIVATE".repeat(100_000),
    }),
  ]);
  const middle = jsonl([
    event("agent_message", "This middle message must not be read"),
  ]);
  const tail = jsonl([
    event("user_message", "Check the final edge too"),
    message("assistant", "Final edge is readable.", { channel: "final" }),
  ]);
  const reader = new DescriptionReader();
  writeFileSync(
    fixture.path,
    `${head}${filler}${middle}${filler}${tail}{"type":"event_msg","payload":`,
  );
  const recent = await describe(fixture.native, fixture.home, reader);
  assert.equal(recent.title, "Repair shipment validation");
  assert.equal(recent.preview, "Final edge is readable.");
  writeFileSync(fixture.path, `${head}${filler}${middle}${filler}`);
  const bounded = await describe(fixture.native, fixture.home, reader);
  assert.equal(bounded.title, "Repair shipment validation");
  assert.equal(bounded.preview, "Repair shipment validation");
});

test("only a parsed request_user_input question is shown while waiting on user input", async (t) => {
  const native = thread({
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const fixture = rollout(t, native, [
    meta(native),
    event("user_message", native.preview),
    question(
      {
        questions: [
          {
            id: "PRIVATE ID",
            header: "PRIVATE header",
            question: "Which\n address should I use?",
            options: [
              {
                label: "PRIVATE option",
                description: "PRIVATE option description",
              },
            ],
          },
        ],
        other: "PRIVATE other arguments",
      },
      "functions.request_user_input",
    ),
    record("response_item", {
      type: "function_call_output",
      output: "PRIVATE output after question",
    }),
  ]);
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.status, "waiting");
  assert.equal(row.title, "Shipping repair");
  assert.equal(row.preview, "Which address should I use?");
  assert.doesNotMatch(row.preview, /PRIVATE|questions|arguments/);

  for (const status of [
    { type: "idle" },
    { type: "active", activeFlags: ["waitingOnApproval"] },
  ]) {
    const notUserInput = await describe(
      { ...fixture.native, status },
      fixture.home,
    );
    assert.equal(notUserInput.preview, native.preview);
  }
});

test("only unanswered questions take precedence over recent commentary", async (t) => {
  const native = thread({
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const ask = question({ questions: [{ question: "Which address?" }] });
  ask.payload.call_id = "question-1";
  const fixture = rollout(t, native, [
    meta(native),
    event("user_message", native.preview),
    ask,
    event("agent_message", "Waiting for your choice."),
  ]);
  assert.equal(
    (await describe(fixture.native, fixture.home)).preview,
    "Which address?",
  );
  writeFileSync(
    fixture.path,
    jsonl([
      meta(native),
      ask,
      record("response_item", {
        type: "function_call_output",
        call_id: "question-1",
        output: "PRIVATE answer",
      }),
      event("agent_message", "Address confirmed."),
    ]),
  );
  assert.equal(
    (await describe(fixture.native, fixture.home)).preview,
    "Address confirmed.",
  );
});

test("questions from the head cannot cross an unread gap and override recent text", async (t) => {
  const native = thread({
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const oldQuestion = question({
    questions: [{ question: "Old answered question" }],
  });
  oldQuestion.payload.call_id = "old-question";
  const filler = record("response_item", {
    type: "function_call_output",
    output: "PRIVATE".repeat(100_000),
  });
  const fixture = rollout(t, native, [
    meta(native),
    oldQuestion,
    filler,
    record("response_item", {
      type: "function_call_output",
      call_id: "old-question",
      output: "PRIVATE answer",
    }),
    filler,
    event("agent_message", "Latest readable progress."),
  ]);
  assert.equal(
    (await describe(fixture.native, fixture.home)).preview,
    "Latest readable progress.",
  );
});

test("malformed questions never expose raw tool arguments", async (t) => {
  const native = thread({
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const fixture = rollout(t, native, [
    meta(native),
    question("PRIVATE invalid JSON"),
    question({ questions: [{ header: "PRIVATE header" }] }),
    question(
      { questions: [{ question: "PRIVATE unrelated tool" }] },
      "exec_command",
    ),
  ]);
  assert.equal(
    (await describe(fixture.native, fixture.home)).preview,
    native.preview,
  );
});

test("rollout session metadata must match both the exact native id and cwd", async (t) => {
  const native = thread();
  for (const metadata of [
    [],
    [meta(native, { id: "other-thread" })],
    [meta(native, { cwd: "/other/project" })],
    [meta(native, { cwd: `${native.cwd}/` })],
    [meta(native), meta(native, { id: "another-thread" })],
  ]) {
    const fixture = rollout(t, native, [
      ...metadata,
      event("agent_message", "Must not be used"),
    ]);
    const row = await describe(fixture.native, fixture.home);
    assert.deepEqual(row, codexRow(fixture.native, "/tmp/codex.sock"));
  }
});

test("realpath containment rejects outside paths, symlinks and nonregular files before reading", async (t) => {
  const home = temporary(t);
  const outside = temporary(t);
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "sessions-evil"));
  const native = thread();
  const records = jsonl([
    meta(native),
    event("agent_message", "Must not be read"),
  ]);
  const external = join(outside, "outside.jsonl");
  const sibling = join(home, "sessions-evil", "outside.jsonl");
  const homeRoot = join(home, "root.jsonl");
  writeFileSync(external, records);
  writeFileSync(sibling, records);
  writeFileSync(homeRoot, records);
  const linkedFile = join(home, "sessions", "linked.jsonl");
  const linkedDirectory = join(home, "sessions", "linked-directory");
  symlinkSync(external, linkedFile);
  symlinkSync(outside, linkedDirectory, "dir");
  let reads = 0;
  const reader = {
    async jsonl() {
      reads++;
      return { head: [], tail: [] };
    },
  };
  for (const path of [
    external,
    sibling,
    homeRoot,
    join(home, "sessions", "..", "root.jsonl"),
    linkedFile,
    join(linkedDirectory, "outside.jsonl"),
    join(home, "sessions"),
    "relative.jsonl",
  ]) {
    const row = await describe({ ...native, path }, home, reader);
    assert.equal(row.preview, native.preview);
  }
  assert.equal(reads, 0);

  const symlinkHome = temporary(t);
  symlinkSync(outside, join(symlinkHome, "sessions"), "dir");
  await describe(
    { ...native, path: join(symlinkHome, "sessions", "outside.jsonl") },
    symlinkHome,
    reader,
  );
  assert.equal(reads, 0, "an allowed root symlink must not escape CODEX_HOME");
});

test("archived_sessions under configured home can provide recent text", async (t) => {
  const native = thread();
  const fixture = rollout(
    t,
    native,
    [meta(native), event("agent_message", "Archived context")],
    "archived_sessions",
  );
  assert.equal(
    (await describe(fixture.native, fixture.home)).preview,
    "Archived context",
  );
});

test("missing, corrupt and unavailable rollout paths preserve the native row and status", async (t) => {
  const native = thread({ status: { type: "systemError" } });
  const fixture = rollout(t, native, []);
  for (const path of [
    undefined,
    null,
    join(fixture.home, "sessions", "missing.jsonl"),
    fixture.path,
  ]) {
    if (path === fixture.path)
      writeFileSync(path, 'PRIVATE invalid JSON\n{"type":');
    const candidate = { ...native, path };
    const row = await describe(candidate, fixture.home);
    assert.deepEqual(row, codexRow(candidate, "/tmp/codex.sock"));
    assert.equal(row.status, "error");
    assert.equal(row.live, true);
    assert.equal(row.updated, 100_000);
    assert.match(row.nativeCommand, /codex resume --remote/);
  }
});

test("valid records survive corrupt lines without treating skipped content as an empty session", async (t) => {
  const native = thread({ name: "", preview: "" });
  const fixture = rollout(t, native, [meta(native)]);
  writeFileSync(
    fixture.path,
    `${jsonl([meta(native)])}PRIVATE corrupt record\n`,
  );
  const unknown = await describe(fixture.native, fixture.home);
  assert.equal(unknown.title, "Codex in shipping");
  writeFileSync(
    fixture.path,
    `invalid line\n${jsonl([meta(native), event("user_message", "Actual task after invalid line"), event("agent_message", "Readable progress")])}`,
  );
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.title, "Actual task after invalid line");
  assert.equal(row.preview, "Readable progress");
});

test("New session is reserved for a verified metadata-only rollout with an empty native preview", async (t) => {
  const native = thread({ name: "", preview: "" });
  const fixture = rollout(t, native, [meta(native)]);
  const row = await describe(fixture.native, fixture.home);
  assert.equal(row.title, "New session");
  assert.equal(row.preview, "");
  const unavailable = await describe(
    { ...fixture.native, preview: undefined },
    fixture.home,
  );
  assert.equal(unavailable.title, "Codex in shipping");
});

test("rollout enrichment propagates cancellation", async (t) => {
  const native = thread();
  const fixture = rollout(t, native, [meta(native)]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    enrichCodexRow(
      fixture.native,
      codexRow(fixture.native, "/tmp/codex.sock"),
      new DescriptionReader(),
      fixture.home,
      controller.signal,
    ),
    /abort/i,
  );
});

test("adapter enriches local descriptions using only the original read-only request set", async (t) => {
  const native = thread({
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const fixture = rollout(t, native, [
    meta(native),
    event("user_message", native.preview),
    question({
      questions: [
        { question: "Which test should run?", header: "PRIVATE header" },
      ],
    }),
  ]);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture.home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  const socket = join(fixture.home, "sock");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests = [];
  wss.on("connection", (client) => {
    client.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (request.method === "initialized") return;
      const result =
        request.method === "initialize"
          ? {}
          : request.method === "thread/loaded/list"
            ? { data: [native.id], nextCursor: null }
            : { thread: fixture.native };
      client.send(JSON.stringify({ id: request.id, result }));
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
  const [row] = await createCodexAdapter(socket).list(
    AbortSignal.timeout(3000),
  );
  assert.equal(row.title, "Shipping repair");
  assert.equal(row.preview, "Which test should run?");
  assert.equal(row.nativeId, native.id);
  assert.equal(row.status, "waiting");
  assert.equal(row.updated, 100_000);
  assert.deepEqual(row.owners, []);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "thread/loaded/list", "thread/read"],
  );
  assert.deepEqual(requests.at(-1).params, {
    threadId: native.id,
    includeTurns: false,
  });
});
