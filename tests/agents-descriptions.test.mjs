import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const jiti = createJiti(import.meta.url);
const { DescriptionReader, meaningfulTitle } = await jiti.import(
  join(root, "extensions/agents/descriptions.ts"),
);
const { claudeRows, createClaudeAdapter, describeClaudeSession } =
  await jiti.import(join(root, "extensions/agents/claude.ts"));
const { localTmuxRows, mergeLocalTmux } = await jiti.import(
  join(root, "extensions/agents/local-tmux.ts"),
);

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "agd-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function env(t, name, value) {
  const old = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}
function put(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}
function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}
const native = {
  id: "ee1e0177",
  sessionId: "ee1e0177-c05c-4729-a5b0-33dd2ae4816d",
  cwd: "/work/notes",
  name: "ee1e0177",
  kind: "background",
  status: "idle",
  pid: 123,
};
function message(type, text, extra = {}) {
  return {
    type,
    sessionId: native.sessionId,
    cwd: native.cwd,
    message: { role: type, content: text },
    ...extra,
  };
}
function transcript(root, id = native.sessionId) {
  return join(root, "projects", "-work-notes", `${id}.jsonl`);
}
function job(root, state) {
  put(
    join(root, "jobs", native.id, "state.json"),
    JSON.stringify({
      sessionId: native.sessionId,
      cwd: native.cwd,
      ...state,
    }),
  );
}
async function describe(
  root,
  session = native,
  reader = new DescriptionReader(),
) {
  const before = claudeRows([session])[0];
  const result = await describeClaudeSession(
    before,
    session,
    root,
    reader,
    AbortSignal.timeout(3000),
  );
  const { title: _title, preview: _preview, ...original } = before;
  const { title, preview, ...state } = result;
  assert.deepEqual(
    state,
    original,
    "display metadata cannot change native state or identity",
  );
  return result;
}

test("meaningful titles reject opaque identities and sanitize terminal controls", () => {
  for (const title of [
    native.id,
    native.sessionId,
    "job-4abb1f45",
    "f".repeat(64),
    "session-a session-a",
    "New session",
    "\x1b[31m",
    " \n\t ",
  ])
    assert.equal(
      meaningfulTitle(title, [native.id, native.sessionId, "session-a"]),
      "",
      title,
    );
  assert.equal(
    meaningfulTitle("\x1b[31mReview\n notes\x1b[0m\u202e"),
    "Review notes",
  );
  assert.equal(
    meaningfulTitle("Repair billing totals"),
    "Repair billing totals",
  );
});

test("metadata readers cache changed files, tolerate partial writes and skip nonregular files", async (t) => {
  const home = temporary(t);
  const file = join(home, "records.jsonl");
  const reader = new DescriptionReader();
  put(file, '{"text":"first"}\ninvalid\n{"partial":');
  assert.deepEqual(await reader.jsonl(file, AbortSignal.timeout(1000)), {
    head: [{ text: "first" }],
    tail: [],
  });
  put(file, '{"text":"second and longer"}\n');
  assert.deepEqual(await reader.jsonl(file, AbortSignal.timeout(1000)), {
    head: [{ text: "second and longer" }],
    tail: [],
  });
  symlinkSync(file, join(home, "linked"));
  for (const path of [join(home, "missing"), join(home, "linked"), home])
    assert.deepEqual(await reader.jsonl(path, AbortSignal.timeout(1000)), {
      head: [],
      tail: [],
    });
  const state = join(home, "state.json");
  put(state, JSON.stringify({ text: "large".repeat(20_000) }));
  assert.equal(await reader.json(state, AbortSignal.timeout(1000)), undefined);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.jsonl(file, controller.signal), /abort/i);
});

test("bounded reads retain complete records on and across adjacent edge boundaries", async (t) => {
  const file = join(temporary(t), "edges.jsonl");
  const reader = new DescriptionReader();
  const edge = 256 * 1024;
  const latest = { text: "Latest complete message" };
  for (const padding of [edge - 1, edge - 10]) {
    put(file, " ".repeat(padding) + "\n" + jsonl([latest]));
    const result = await reader.jsonl(file, AbortSignal.timeout(1000));
    assert.deepEqual([...result.head, ...result.tail], [latest]);
  }
  const unicode = { text: "Übung 🥋" };
  const encoded = jsonl([unicode]);
  const beforeUnicode = Buffer.byteLength(
    encoded.slice(0, encoded.indexOf("Ü")),
  );
  put(file, " ".repeat(edge - 2 - beforeUnicode) + "\n" + encoded);
  assert.deepEqual((await reader.jsonl(file, AbortSignal.timeout(1000))).head, [
    unicode,
  ]);
  const firstTail = { text: "First complete record in the tail" };
  const tail = jsonl([firstTail]);
  const filler = {
    padding: "x".repeat(edge - tail.length - jsonl([{ padding: "" }]).length),
  };
  put(file, " ".repeat(3 * edge - 1) + "\n" + tail + jsonl([filler]));
  const result = await reader.jsonl(file, AbortSignal.timeout(1000));
  assert.equal(result.gap, true);
  assert.deepEqual(result.tail[0], firstTail);
});

test("Claude strips injected context within mixed-content messages before flattening", async (t) => {
  const home = temporary(t);
  put(
    transcript(home),
    jsonl([
      message("user", [
        { type: "text", text: "Check invoice totals." },
        {
          type: "text",
          text: "<system-reminder>PRIVATE injected instructions</system-reminder>",
        },
      ]),
      message(
        "assistant",
        "Totals match.\n<system-reminder>PRIVATE reminder</system-reminder>",
      ),
    ]),
  );
  const row = await describe(home);
  assert.equal(row.title, "Check invoice totals.");
  assert.equal(row.preview, "Totals match.");
  assert.doesNotMatch(row.title + row.preview, /PRIVATE|reminder|instructions/);
});

test("Claude hash titles fall back to the first real prompt and preview the newest text", async (t) => {
  const home = temporary(t);
  put(
    transcript(home),
    jsonl([
      message("user", "PRIVATE meta", { isMeta: true }),
      message("user", "PRIVATE sidechain", { isSidechain: true }),
      message("user", "<command-name>/resume</command-name>"),
      message("user", [
        { type: "tool_result", content: "PRIVATE tool output" },
      ]),
      message("user", "Please review the notes changes."),
      message("assistant", [{ type: "text", text: "Review complete." }]),
      message("user", "Please add regression tests."),
      message("assistant", [
        { type: "thinking", thinking: "PRIVATE reasoning" },
        { type: "text", text: "Tests added.\x1b]52;c;PRIVATE clipboard\x07" },
        { type: "tool_use", input: { secret: "PRIVATE arguments" } },
      ]),
      message("user", "PRIVATE other session", { sessionId: "different" }),
      message("user", "PRIVATE other cwd", { cwd: "/different" }),
    ]),
  );
  const row = await describe(home);
  assert.equal(row.title, "Please review the notes changes.");
  assert.equal(row.preview, "Tests added.");
  assert.equal(row.nativeId, native.sessionId);
  assert.doesNotMatch(row.title + row.preview, /PRIVATE|tool|thinking/);
  assert.equal(
    (await describe(home, { ...native, name: "My chosen title" })).title,
    "My chosen title",
  );
  assert.equal(
    (await describe(home, { ...native, name: "notes-8a" })).title,
    "Please review the notes changes.",
    "generated project labels give way to an actual task",
  );
});

test("Claude titles stay stable while the recent preview changes", async (t) => {
  const home = temporary(t);
  const reader = new DescriptionReader();
  const first = message("user", "Repair invoice totals");
  put(
    transcript(home),
    jsonl([first, message("assistant", "Checking totals.")]),
  );
  const initial = await describe(home, native, reader);
  put(
    transcript(home),
    jsonl([first, message("assistant", "Totals now match the invoice.")]),
  );
  const updated = await describe(home, native, reader);
  assert.equal(updated.title, initial.title);
  assert.equal(updated.preview, "Totals now match the invoice.");
});

test("Claude reads the verified resumed session and prioritizes its saved blocker", async (t) => {
  const home = temporary(t);
  const resumed = "4e840f3d-43c3-47d5-9e4e-f775fb952427";
  job(home, {
    resumeSessionId: resumed,
    needs: "Which date should I book?",
    linkScanPath: "/private/arbitrary-file",
  });
  put(
    transcript(home, resumed),
    jsonl([
      message("user", "Schedule the team retro", { sessionId: resumed }),
      message("assistant", "Checking calendars.", { sessionId: resumed }),
    ]),
  );
  const session = { ...native, pid: undefined, status: "waiting" };
  const row = await describe(home, session);
  assert.equal(row.title, "Schedule the team retro");
  assert.equal(row.preview, "Which date should I book?");
  assert.equal(row.status, "waiting");
  assert.equal(
    (
      await describe(home, {
        ...session,
        waitingFor: "Approve the invitation?",
      })
    ).preview,
    "Approve the invitation?",
  );
  assert.equal(
    (await describe(home, native)).preview,
    "Checking calendars.",
    "a blocker never overrides live idle status",
  );
});

test("only an explicit empty-job marker produces the awaiting-first-prompt label", async (t) => {
  const home = temporary(t);
  assert.equal((await describe(home)).title, "Claude in notes");
  job(home, { needs: "send a prompt to start", intent: "" });
  const row = await describe(home);
  assert.equal(row.title, "New session · awaiting first prompt");
  assert.equal(row.preview, "Awaiting first prompt.");
  assert.equal(row.status, "ready");
  put(transcript(home), jsonl([message("user", "Review the notes")]));
  const started = await describe(home);
  assert.equal(started.title, "Review the notes");
  assert.equal(started.preview, "Review the notes");
});

test("mismatched, corrupt and missing Claude metadata never takes discovery down", async (t) => {
  const home = temporary(t);
  for (const state of [
    { sessionId: "another", needs: "PRIVATE blocker", intent: "PRIVATE task" },
    { cwd: "/another", needs: "PRIVATE blocker", intent: "PRIVATE task" },
    { resumeSessionId: "../../private", linkScanPath: "/private/arbitrary" },
  ]) {
    job(home, state);
    const row = await describe(home, { ...native, status: "waiting" });
    assert.equal(row.title, "Claude in notes");
    assert.equal(row.preview, "");
  }
  put(join(home, "jobs", native.id, "state.json"), "corrupt");
  put(transcript(home), 'corrupt\n{"partial":');
  assert.equal((await describe(home)).title, "Claude in notes");
});

test("Claude adapter honors its config directory and only invokes native read-only discovery", async (t) => {
  const home = temporary(t);
  const bin = join(home, "bin");
  const config = join(home, "custom config");
  put(
    join(bin, "claude"),
    `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2)) !== '["agents","--json"]') process.exit(1); console.log(${JSON.stringify(JSON.stringify([null, native]))});\n`,
  );
  const { chmodSync } = await import("node:fs");
  chmodSync(join(bin, "claude"), 0o700);
  env(t, "PATH", bin);
  env(t, "CLAUDE_CONFIG_DIR", config);
  put(
    transcript(config),
    jsonl([message("user", "Review custom-directory notes")]),
  );
  const [row] = await createClaudeAdapter().list(AbortSignal.timeout(3000));
  assert.equal(row.title, "Review custom-directory notes");
  assert.equal(row.preview, "Review custom-directory notes");
  assert.match(row.nativeCommand, /CLAUDE_CONFIG_DIR=/);
});

function pane(agent, title, name = "job-deadbeef") {
  return (
    [
      "/tmp/agents.sock",
      "$42",
      "%7",
      "0",
      "/work/notes",
      name,
      agent,
      "123",
      title,
    ].join("\t") + "\n"
  );
}

test("tmux-only Claude and Codex use meaningful pane titles without guessing thread ownership", () => {
  for (const agent of ["claude", "codex"]) {
    const [row] = mergeLocalTmux(
      localTmuxRows(pane(agent, "✳ Repair billing totals"), []),
    );
    assert.equal(row.title, "Repair billing totals");
    assert.equal(row.source, agent);
    assert.equal(row.status, "unknown");
    assert.equal(row.nativeId, undefined);
    assert.deepEqual(row.tmux, {
      socket: "/tmp/agents.sock",
      session: "$42",
      pane: "%7",
    });
    const [named] = mergeLocalTmux(
      localTmuxRows(pane(agent, "", "billing-repair"), []),
    );
    assert.equal(named.title, "billing-repair");
  }
  for (const title of [
    "✳ Claude Code",
    "OpenAI Codex",
    "2 awaiting input · claude agents",
    "ee1e0177",
  ])
    assert.equal(
      mergeLocalTmux(localTmuxRows(pane("claude", title), []))[0].title,
      "Claude in notes",
    );
  assert.equal(
    mergeLocalTmux(
      localTmuxRows(pane("pi", "Some different task", "custom-name"), []),
    )[0].title,
    "Pi in notes",
    "Pi fallback behavior is unchanged",
  );
});
