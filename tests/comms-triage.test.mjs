import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const { Check } = require("typebox/value");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
    "@earendil-works/pi-ai": join(dirname(packageDir), "pi-ai/dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  },
});
const source = join(root, "extensions/comms");
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { SessionManager } = await import(
  pathToFileURL(join(packageDir, "dist/index.js"))
);
const { createEventBus } = await import(
  pathToFileURL(join(packageDir, "dist/core/event-bus.js"))
);
const { runClaudeTriage, claimTriage, claudeArgs } = await jiti.import(
  join(source, "claude-triage.ts"),
);
const { parseTriage, mergeTriage, externalPrompt, triageSchema } =
  await jiti.import(join(source, "triage-protocol.ts"));
const { decision, readTools } = await import(
  pathToFileURL(join(source, "triage-guard.mjs"))
);
const { emptyState, demoState, ingest, setDraft, errorMessage } =
  await jiti.import(join(source, "state.ts"));
const { Store } = await jiti.import(join(source, "store.ts"));
const first = "2026-10-19T08:00:00.000Z";
const second = "2026-10-19T09:00:00.000Z";
const item = (id = "one", updated = first) => ({
  sourceId: id,
  sourceUpdatedAt: updated,
  title: "Review request",
  person: "Fixture colleague",
  summary: "Please review",
  suggestion: "Review and reply",
  priority: 1,
});
const resolution = (overrides = {}) => ({
  sourceId: "one",
  sourceUpdatedAt: first,
  evidenceId: "sent-reply-one",
  evidenceAt: "2026-10-19T08:49:00.000Z",
  reason:
    "The sent reply fully answers this request with no remaining promise.",
  ...overrides,
});
const result = (overrides = {}) => ({
  source: "mail",
  account: "work@example.invalid",
  status: "complete",
  detail: "Fixture all pages",
  items: [item()],
  ...overrides,
});
const payload = (results = [result()]) => ({ runId: "fixture-run", results });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "comms-triage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function env(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}
function fakeClaude(t, behavior = {}) {
  const dir = temporary(t),
    bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "behavior.json"), JSON.stringify(behavior));
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
const fs=require('node:fs');
const dir=${JSON.stringify(dir)};
let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const options=JSON.parse(fs.readFileSync(dir+'/behavior.json','utf8'));
 fs.writeFileSync(dir+'/request.json',JSON.stringify({args:process.argv.slice(2),prompt:input,cwd:process.cwd(),claudecode:process.env.CLAUDECODE}));
 if(options.wait){
  if(options.ignoreTerm)process.on('SIGTERM',()=>{});
  if(options.descendant)require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync("+JSON.stringify(dir+'/descendant-pid')+", String(process.pid)); setInterval(()=>{},1000);"],{stdio:'ignore'});
  fs.writeFileSync(dir+'/pid',String(process.pid));
  setInterval(()=>{},1000);return;
 }
 if(options.overflow){process.stdout.write('x'.repeat(17*1024*1024));return;}
 if(options.malformed){process.stdout.write('not json\\n');return;}
 const runId=input.match(/Run ID: ([^.\\s]+)/)[1];
 const data=options.data?{runId,...options.data}:{runId,results:[${JSON.stringify(result())}]};
 if(options.tool)console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:options.tool,input:options.toolInput}]}}));
 const event={type:'result',subtype:options.subtype||'success',is_error:options.isError||false,structured_output:data,permission_denials:options.denied||[]};
 const line=JSON.stringify(event)+'\\n';
 process.stdout.write(line.slice(0,15));
 setTimeout(()=>{process.stdout.write(line.slice(15));if(options.exit)process.exitCode=options.exit},5);
});
`,
    { mode: 0o700 },
  );
  env(t, "PATH", `${bin}:${process.env.PATH}`);
  return { dir, options: join(dir, "behavior.json") };
}
function request(cwd, overrides = {}) {
  return {
    cwd,
    runId: "fixture-run",
    startedAt: second,
    state: emptyState(),
    instructions: "Canonical fixture filters",
    signal: new AbortController().signal,
    progress() {},
    ...overrides,
  };
}
async function waitFor(file) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fixture never wrote ${file}`);
}

test("tool hook allows exact reviewed reads and denies everything else", () => {
  for (const name of readTools)
    assert.equal(
      decision({ tool_name: name }).hookSpecificOutput.permissionDecision,
      "allow",
    );
  for (const name of [
    "Bash",
    "Read",
    "Write",
    "Agent",
    "Task",
    "Skill",
    "mcp__claude_ai_Microsoft_365__outlook_send_mail",
    "mcp__claude_ai_Microsoft_365__outlook_create_draft",
    "mcp__claude_ai_Notion__notion-create-pages",
    "mcp__notion-api__API-post-page",
    "mcp__anything__read_then_send",
    undefined,
  ])
    assert.equal(
      decision({ tool_name: name }).hookSpecificOutput.permissionDecision,
      "deny",
    );
  const script = join(source, "triage-guard.mjs");
  const output = execFileSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: "Bash" }),
    encoding: "utf8",
  });
  assert.equal(
    JSON.parse(output).hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [script], {
        input: "broken",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    (error) => error.status === 2,
  );
});

test("Claude launch reuses auth with a read hook and no bypass, file or shell tools", () => {
  const args = claudeArgs();
  assert.equal(args[args.indexOf("--tools") + 1], "ToolSearch");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(
    !args.some(
      (arg) =>
        arg.includes("skip-permissions") ||
        arg === "--bare" ||
        arg === "--mcp-config",
    ),
  );
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.disableAllHooks, false);
  assert.equal(settings.hooks.PreToolUse[0].matcher, ".*");
  assert.ok(
    settings.hooks.PreToolUse[0].hooks[0].command.endsWith("triage-guard.mjs'"),
  );
});

test("structured results fill missing sources and known accounts without claiming success", () => {
  const previous = emptyState();
  ingest(previous, "mail", "second-account", [], "complete", "prior", first);
  const rows = parseTriage(payload(), "fixture-run", previous);
  assert.equal(rows.length, 5);
  assert.equal(
    rows.find((row) => row.account === "second-account").status,
    "unavailable",
  );
  for (const source of ["teams", "calendar", "notion"])
    assert.equal(
      rows.find((row) => row.source === source).status,
      "unavailable",
    );
  const state = structuredClone(previous);
  mergeTriage(state, rows, second);
  assert.equal(
    state.coverage.find((row) => row.account === "second-account").cursor,
    first,
  );
});

test("invalid envelopes and unattributable results still reject the whole run", () => {
  for (const bad of [
    null,
    { ...payload(), runId: "wrong" },
    payload([]),
    payload(Array.from({ length: 101 }, () => result())),
    payload([null]),
    payload([result({ source: "unknown" })]),
    payload([result({ account: "" })]),
    payload([result({ account: "\u001b[31m" })]),
    payload([result({ account: "x".repeat(301) })]),
  ])
    assert.throws(() => parseTriage(bad, "fixture-run", emptyState()));
});

test("the schema has no meeting source and ordinary links stay optional", () => {
  assert.equal(Check(triageSchema, payload()), true);
  const args = claudeArgs();
  assert.deepEqual(
    JSON.parse(args[args.indexOf("--json-schema") + 1]),
    JSON.parse(JSON.stringify(triageSchema)),
  );
  assert.equal(
    Check(triageSchema, payload([result({ source: "meetings", items: [] })])),
    false,
  );
});

test("structured uncertainty is optional, validated and retained through collection", () => {
  const candidate = { ...item(), uncertainty: "Whether a colleague answered." };
  const data = payload([result({ items: [candidate] })]);
  assert.equal(Check(triageSchema, data), true);
  const state = emptyState();
  const rows = parseTriage(data, "fixture-run", state);
  assert.equal(rows[0].items[0].uncertainty, candidate.uncertainty);
  mergeTriage(state, rows, second);
  assert.equal(state.items[0].uncertainty, candidate.uncertainty);
  for (const uncertainty of [null, false, {}, "x".repeat(2001)]) {
    const invalid = payload([result({ items: [{ ...item(), uncertainty }] })]);
    assert.equal(Check(triageSchema, invalid), false);
    const rejected = parseTriage(invalid, "fixture-run", state);
    assert.equal(rejected[0].status, "unavailable");
    assert.deepEqual(rejected[0].items, []);
    assert.match(rejected[0].detail, /uncertainty/);
  }
});

test("identical request records collapse after normalization without losing complete coverage", () => {
  for (const [source, candidate, duplicate] of [
    ["mail", item(), { ...item(), sourceUpdatedAt: "2026-10-19T08:00:00Z" }],
  ]) {
    const state = emptyState();
    const rows = parseTriage(
      payload([result({ source, items: [candidate, duplicate] })]),
      "fixture-run",
      state,
    );
    assert.equal(rows[0].status, "complete");
    assert.equal(rows[0].items.length, 1);
    mergeTriage(state, rows, second);
    assert.equal(state.items.length, 1);
    assert.equal(state.coverage[0].cursor, second);
  }
});

test("conflicting duplicates reject only their account and preserve previous items, drafts and cursors", () => {
  for (const changes of [
    { summary: "Different evidence" },
    { uncertainty: "Unverified reply" },
    { priority: 2 },
    { sourceUpdatedAt: second },
    { url: "https://example.com/different" },
  ]) {
    const state = emptyState();
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item()],
      "complete",
      "prior",
      first,
    );
    setDraft(state, state.items[0].key, 0, "My reviewed draft");
    state.items[0].status = "dismissed";
    const previous = structuredClone(state.items[0]);
    const rows = parseTriage(
      payload([
        result({ items: [item(), { ...item(), ...changes }] }),
        result({ account: "other-account" }),
        result({ source: "teams" }),
      ]),
      "fixture-run",
      state,
    );
    assert.equal(rows[0].status, "unavailable");
    assert.deepEqual(rows[0].items, []);
    assert.match(rows[0].detail, /Conflicting duplicate request IDs/);
    mergeTriage(state, rows, second);
    assert.equal(state.items.length, 3);
    assert.deepEqual(
      state.items.find((row) => row.key === previous.key),
      previous,
    );
    assert.equal(
      state.coverage.find(
        (row) =>
          row.source === "mail" && row.account === "work@example.invalid",
      ).cursor,
      first,
    );
    assert.equal(
      state.coverage.find((row) => row.account === "other-account").cursor,
      second,
    );
    assert.equal(
      state.coverage.find((row) => row.source === "teams").cursor,
      second,
    );
  }
});

test("invalid source results become unavailable without importing any of their items", () => {
  for (const bad of [
    result({ account: "unverified" }),
    result({ status: "unavailable" }),
    result({ status: "unknown" }),
    result({ detail: "x".repeat(501) }),
    result({ items: undefined }),
    result({ items: Array.from({ length: 1001 }, () => item()) }),
    result({
      items: [item(), { ...item("bad"), sourceUpdatedAt: "invented" }],
    }),
    result({ items: [{ ...item(), url: "javascript:alert(1)" }] }),
    result({ items: [{ ...item(), title: "x".repeat(241) }] }),
    result({ items: [null] }),
  ]) {
    const state = emptyState();
    ingest(state, bad.source, bad.account, [], "partial", "prior", first);
    const rows = parseTriage(
      payload([bad, result({ source: "teams" })]),
      "fixture-run",
      state,
    );
    assert.equal(rows[0].status, "unavailable");
    assert.deepEqual(rows[0].items, []);
    assert.match(
      rows[0].detail,
      /Collection rejected:.*previous checkpoint retained/,
    );
    mergeTriage(state, rows, second);
    assert.deepEqual(
      state.items.map((row) => row.source),
      ["teams"],
    );
    assert.equal(
      state.coverage.find((row) => row.source === bad.source).cursor,
      undefined,
    );
  }
});

test("duplicate source/account rows cannot overwrite a rejection, even nonconsecutively", () => {
  const state = emptyState();
  const rows = parseTriage(
    payload([
      result(),
      result({ source: "teams" }),
      result({ items: [item("other")] }),
      result(),
    ]),
    "fixture-run",
    state,
  );
  assert.equal(rows.filter((row) => row.source === "mail").length, 1);
  assert.equal(rows[0].status, "unavailable");
  assert.deepEqual(rows[0].items, []);
  assert.match(rows[0].detail, /Duplicate source\/account results/);
  mergeTriage(state, rows, second);
  assert.deepEqual(
    state.items.map((row) => row.source),
    ["teams"],
  );
});

test("shared ingestion deduplicates identical records and rejects conflicts before changing state", () => {
  const state = emptyState();
  ingest(state, "mail", "work", [item(), item()], "complete", "all", first);
  assert.equal(state.items.length, 1);
  const before = structuredClone(state);
  assert.throws(
    () =>
      ingest(
        state,
        "mail",
        "work",
        [item("new"), item(), { ...item(), summary: "conflict" }],
        "complete",
        "all",
        second,
      ),
    /Conflicting duplicate/,
  );
  assert.deepEqual(state, before);
});

test("error messages omit wrapper prefixes and still sanitize terminal controls", () => {
  assert.equal(
    errorMessage(new Error("\u001b[31mInvalid result.")),
    "Invalid result.",
  );
  assert.equal(
    errorMessage("Connector unavailable."),
    "Connector unavailable.",
  );
});

test("queue merging re-reads current edits, retains backlog and advances only complete cursors", (t) => {
  const store = new Store(join(temporary(t), "queue"));
  store.update((state) => {
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item()],
      "complete",
      "ok",
      first,
    );
  });
  const rows = parseTriage(
    payload([result({ items: [item("new")], status: "partial" })]),
    "fixture-run",
    store.read(),
  );
  store.update((state) => {
    const current = state.items[0];
    setDraft(state, current.key, 0, "My concurrent edited reply");
    current.status = "waiting";
  });
  const merged = store.update((state) => mergeTriage(state, rows, second));
  assert.equal(merged.items.length, 2);
  assert.equal(merged.items[0].draft, "My concurrent edited reply");
  assert.equal(merged.items[0].status, "waiting");
  assert.equal(merged.coverage[0].cursor, first);
});

test("a synthetic forecast reply explicitly resolves the retained request and preserves its draft", (t) => {
  const store = new Store(join(temporary(t), "queue"));
  const prior = store.update((state) => {
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item("forecast")],
      "complete",
      "prior",
      first,
    );
    setDraft(state, state.items[0].key, 0, "My reviewed forecast reply");
  });
  const resolution = {
    sourceId: "forecast",
    sourceUpdatedAt: first,
    evidenceId: "sent-forecast-reply",
    evidenceAt: "2026-10-19T08:49:00.000Z",
    reason:
      "Synthetic User sent Synthetic Recipient the test forecast. No further action remains.",
  };
  const rows = parseTriage(
    payload([result({ items: [], resolutions: [resolution] })]),
    "fixture-run",
    prior,
    second,
  );
  const state = store.update((current) =>
    mergeTriage(current, rows, second, prior),
  );
  assert.equal(state.items[0].status, "resolved");
  assert.deepEqual(state.items[0].resolution, resolution);
  assert.equal(state.items[0].draft, "My reviewed forecast reply");
  assert.equal(state.items[0].summary, item().summary);
  assert.equal(state.coverage[0].cursor, second);
});

test("resolution schema requires explicit completion evidence", () => {
  const data = payload([result({ items: [], resolutions: [resolution()] })]);
  assert.equal(Check(triageSchema, data), true);
  for (const changes of [
    { sourceId: undefined },
    { sourceUpdatedAt: undefined },
    { evidenceId: undefined },
    { evidenceId: "" },
    { evidenceAt: undefined },
    { reason: "" },
    { reason: "x".repeat(2001) },
    { invented: true },
  ]) {
    assert.equal(
      Check(
        triageSchema,
        payload([result({ items: [], resolutions: [resolution(changes)] })]),
      ),
      false,
    );
  }
});

test("absence, unrelated replies and outstanding promises do not resolve requests", () => {
  for (const detail of [
    "The request was absent from this window.",
    "Synthetic User wrote an unrelated reply to the same synthetic person.",
    "Synthetic User replied promising to send the test forecast later.",
    "The collector claims it dropped the answered item, but supplied no resolution.",
  ]) {
    const state = emptyState();
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item()],
      "complete",
      "prior",
      first,
    );
    const before = structuredClone(state.items);
    const rows = parseTriage(
      payload([result({ items: [], detail })]),
      "fixture-run",
      state,
      second,
    );
    mergeTriage(state, rows, second, structuredClone(state));
    assert.deepEqual(state.items, before);
  }
});

test("invalid resolutions reject only their source/account before any state changes", () => {
  const bad = (overrides = {}) =>
    result({ items: [], resolutions: [resolution()], ...overrides });
  for (const invalid of [
    bad({ resolutions: null }),
    bad({ resolutions: {} }),
    bad({ resolutions: [null] }),
    bad({ resolutions: Array.from({ length: 1001 }, () => resolution()) }),
    ...[
      { evidenceId: undefined },
      { evidenceId: "\u001b[31m" },
      { evidenceAt: "invented" },
      { sourceUpdatedAt: "invented" },
      { evidenceAt: "2026-10-19T09:01:00.000Z" },
      { reason: " " },
      { reason: "x".repeat(2001) },
      { sourceId: "not-retained" },
      { sourceUpdatedAt: second },
    ].map((changes) => bad({ resolutions: [resolution(changes)] })),
    bad({ status: "unavailable" }),
    bad({ account: "unverified", status: "partial" }),
    bad({ account: "another-account" }),
    bad({ source: "calendar" }),
    bad({ items: [item()] }),
    bad({
      resolutions: [
        resolution(),
        resolution({ reason: "Contradictory assessment" }),
      ],
    }),
  ]) {
    const state = emptyState();
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item()],
      "complete",
      "prior",
      first,
    );
    const prior = structuredClone(state);
    const rows = parseTriage(
      payload([invalid, result({ source: "teams" })]),
      "fixture-run",
      prior,
      second,
    );
    assert.equal(rows[0].status, "unavailable", JSON.stringify(invalid));
    assert.deepEqual(rows[0].items, []);
    assert.equal(rows[0].resolutions, undefined);
    mergeTriage(state, rows, second, prior);
    assert.deepEqual(state.items[0], prior.items[0]);
    assert.equal(state.items[1].source, "teams");
    assert.equal(
      state.coverage.find(
        (row) =>
          row.source === "mail" && row.account === "work@example.invalid",
      ).cursor,
      first,
    );
  }
});

test("identical resolutions deduplicate and partial verified coverage can close a checked request", () => {
  const state = emptyState();
  ingest(
    state,
    "mail",
    "work@example.invalid",
    [item()],
    "complete",
    "prior",
    first,
  );
  state.items[0].status = "waiting";
  const prior = structuredClone(state);
  const rows = parseTriage(
    payload([
      result({
        items: [],
        status: "partial",
        resolutions: [
          resolution(),
          resolution({ evidenceAt: "2026-10-19T08:49:00Z" }),
        ],
      }),
    ]),
    "fixture-run",
    prior,
    second,
  );
  assert.equal(rows[0].resolutions.length, 1);
  mergeTriage(state, rows, second, prior);
  assert.equal(state.items[0].status, "resolved");
  assert.deepEqual(state.items[0].resolution, resolution());
  assert.equal(state.coverage[0].status, "partial");
  assert.equal(state.coverage[0].cursor, first);
});

test("stale resolution results preserve concurrent edits and newer collection evidence", (t) => {
  for (const mutate of [
    (state) => setDraft(state, state.items[0].key, 0, "A concurrent edit"),
    (state) => {
      state.items[0].status = "waiting";
    },
    (state) => {
      state.items[0].status = "dismissed";
    },
    (state) => {
      state.items[0].status = "resolved";
    },
    (state) => {
      state.items[0].snoozedUntil = second;
    },
    (state) => {
      state.items[0].reminderAdded = "My accepted action";
    },
    (state) => {
      state.items[0].summary = "New assessment at the same source timestamp";
    },
    (state) =>
      ingest(
        state,
        "mail",
        "work@example.invalid",
        [item("one", second)],
        "complete",
        "newer request",
        second,
      ),
    (state) =>
      ingest(
        state,
        "mail",
        "work@example.invalid",
        [],
        "partial",
        "newer run",
        "2026-10-19T10:00:00.000Z",
      ),
    (state) => {
      state.items = [];
    },
  ]) {
    const store = new Store(join(temporary(t), "queue"));
    const prior = store.update((state) =>
      ingest(
        state,
        "mail",
        "work@example.invalid",
        [item()],
        "complete",
        "prior",
        first,
      ),
    );
    const rows = parseTriage(
      payload([result({ items: [], resolutions: [resolution()] })]),
      "fixture-run",
      prior,
      second,
    );
    const changed = store.update(mutate);
    const merged = store.update((state) =>
      mergeTriage(state, rows, second, prior),
    );
    assert.deepEqual(merged.items, changed.items);
    const coverage = merged.coverage.find((row) => row.source === "mail");
    if (coverage.checkedAt === second)
      assert.match(coverage.detail, /Skipped 1 stale resolution/);
  }
});

test("new source evidence reopens a resolved request and invalidates its old draft editor", () => {
  const state = emptyState();
  ingest(
    state,
    "mail",
    "work@example.invalid",
    [item()],
    "complete",
    "prior",
    first,
  );
  setDraft(state, state.items[0].key, 0, "My saved wording");
  const prior = structuredClone(state);
  const rows = parseTriage(
    payload([result({ items: [], resolutions: [resolution()] })]),
    "fixture-run",
    prior,
    second,
  );
  mergeTriage(state, rows, second, prior);
  assert.throws(
    () => setDraft(state, state.items[0].key, 1, "Stale editor"),
    /changed/,
  );
  ingest(
    state,
    "mail",
    "work@example.invalid",
    [item("one", second)],
    "complete",
    "new evidence",
    second,
  );
  assert.equal(state.items[0].status, "open");
  assert.equal(state.items[0].resolution, undefined);
  assert.equal(state.items[0].draft, "My saved wording");
  assert.equal(state.items[0].draftStale, true);
});

test("shared ingestion requires a run-start snapshot and rejects invalid resolutions atomically", () => {
  const state = emptyState();
  ingest(
    state,
    "mail",
    "work@example.invalid",
    [item()],
    "complete",
    "prior",
    first,
  );
  const prior = structuredClone(state);
  for (const [resolutions, snapshot] of [
    [[resolution()], undefined],
    [[resolution({ evidenceId: "" })], prior],
    [[resolution({ evidenceAt: "2026-10-19T09:01:00.000Z" })], prior],
  ]) {
    assert.throws(() =>
      ingest(
        state,
        "mail",
        "work@example.invalid",
        [item("new")],
        "complete",
        "bad result",
        second,
        resolutions,
        snapshot,
      ),
    );
    assert.deepEqual(state, prior);
  }
});

test("prompt inlines canonical rules and evidence but never includes local drafts", () => {
  const state = demoState(first);
  state.items[0].draft = "PRIVATE-REVIEWED-REPLY";
  const prompt = externalPrompt(
    "fixture-run",
    second,
    state,
    "FILTER-CANONICAL",
  );
  assert.ok(prompt.includes("FILTER-CANONICAL"));
  assert.ok(!prompt.includes("PRIVATE-REVIEWED-REPLY"));
  assert.match(prompt, /ALL actionable candidates/);
  assert.match(prompt, /REPLACE their window, output and act/);
  assert.match(prompt, /A later unrelated message/);
  assert.match(
    prompt,
    /"uncertainty":"Calendar availability has not been checked\."/,
  );
  assert.match(prompt, /Put missing facts, unreadable evidence/);
  assert.doesNotMatch(prompt, /Preserve unresolved uncertainty/);
  assert.match(prompt, /one immediate action/);
  assert.match(prompt, /absolute dates for deadlines/);
  for (const rule of [
    "return resolutions",
    "evidenceId",
    "evidenceAt",
    "no outstanding promise",
    "Never merely omit",
    "both items and resolutions",
  ])
    assert.ok(prompt.includes(rule), rule);
});

test("meeting-note queries are not permitted and transcript fetches fail closed", () => {
  assert.ok(
    readTools.includes("mcp__claude_ai_Notion__notion-get-tool-access"),
  );
  assert.equal(
    readTools.includes("mcp__claude_ai_Notion__notion-query-meeting-notes"),
    false,
  );
  for (const include_transcript of [true, "true", "false", null])
    assert.equal(
      decision({
        tool_name: "mcp__claude_ai_Notion__notion-fetch",
        tool_input: { include_transcript },
      }).hookSpecificOutput.permissionDecision,
      "deny",
    );
  assert.equal(
    decision({
      tool_name: "mcp__claude_ai_Notion__notion-fetch",
      tool_input: { include_transcript: false },
    }).hookSpecificOutput.permissionDecision,
    "allow",
  );
});

test("shared refresh lock rejects a second writer and release is idempotent", (t) => {
  const directory = join(temporary(t), "private");
  new Store(directory).read();
  const release = claimTriage(directory);
  assert.equal(statSync(join(directory, "triage.lock")).mode & 0o777, 0o600);
  assert.throws(() => claimTriage(directory), /Another Comms refresh/);
  release();
  release();
  assert.equal(existsSync(join(directory, "triage.lock")), false);
});

test("fake Claude streams structured results over stdin without parent auth markers", async (t) => {
  const fake = fakeClaude(t, { tool: "mcp__claude_ai_Microsoft_365__get_me" });
  env(t, "CLAUDECODE", "parent-session");
  const progress = [];
  const rows = await runClaudeTriage(
    request(fake.dir, { progress: (text) => progress.push(text) }),
  );
  assert.equal(rows[0].items[0].sourceId, "one");
  assert.equal(rows.length, 4);
  assert.match(progress[0], /get_me/);
  const call = JSON.parse(readFileSync(join(fake.dir, "request.json"), "utf8"));
  assert.equal(call.claudecode, undefined);
  assert.match(call.prompt, /Run ID: fixture-run/);
  assert.ok(
    !call.args.some((arg) => arg.includes("Canonical fixture filters")),
  );
});

for (const [name, behavior, pattern] of [
  ["malformed stream", { malformed: true }, /invalid event stream/],
  ["output limit", { overflow: true }, /output limit/],
  [
    "tool guard",
    { tool: "mcp__claude_ai_Microsoft_365__outlook_send_mail" },
    /outside the Comms read allowlist/,
  ],
  [
    "denied permissions",
    { denied: [{ tool_name: "bad" }] },
    /denied tool calls/,
  ],
  [
    "raw meeting transcript",
    {
      tool: "mcp__claude_ai_Notion__notion-fetch",
      toolInput: { include_transcript: true },
    },
    /outside the Comms read allowlist/,
  ],
  ["failed run", { subtype: "error_max_turns" }, /error_max_turns/],
  ["nonzero exit", { exit: 1 }, /failed/],
])
  test(`${name} fails closed without importing`, async (t) => {
    const fake = fakeClaude(t, behavior);
    await assert.rejects(runClaudeTriage(request(fake.dir)), pattern);
  });

test("cancellation stops an uncooperative owned process and never returns results", async (t) => {
  const fake = fakeClaude(t, { wait: true, ignoreTerm: true });
  const controller = new AbortController();
  const running = runClaudeTriage(
    request(fake.dir, { signal: controller.signal }),
  );
  const rejected = assert.rejects(running, /cancelled/);
  await waitFor(join(fake.dir, "pid"));
  const pid = Number(readFileSync(join(fake.dir, "pid"), "utf8"));
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

async function externalHarness(t, behavior = {}) {
  const fake = fakeClaude(t, behavior);
  const directory = join(fake.dir, "agent");
  const notes = join(fake.dir, "notes");
  env(t, "PI_CODING_AGENT_DIR", directory);
  env(t, "PI_COMMS_NOTES_DIR", notes);
  mkdirSync(join(notes, ".claude/commands"), { recursive: true });
  writeFileSync(
    join(notes, ".claude/commands/triage.md"),
    "Fixture canonical instructions",
  );
  const events = createEventBus();
  const loaded = await loadExtensions(
    [join(source, "index.ts")],
    notes,
    events,
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  mkdirSync(join(notes, ".claude/skills/paste-meetings"), { recursive: true });
  writeFileSync(
    join(notes, ".claude/skills/paste-meetings/SKILL.md"),
    "CANONICAL-MEETING-REFERENCE",
  );
  const prompts = [],
    notices = [],
    notifications = [],
    statuses = [];
  let activeTools = ["read", "bash"];
  loaded.runtime.getActiveTools = () => [...activeTools];
  loaded.runtime.setActiveTools = (names) => {
    activeTools = [...names];
  };
  loaded.runtime.sendUserMessage = (text) => prompts.push(text);
  loaded.runtime.sendMessage = (message) => prompts.push(message.content);
  loaded.runtime.getAllTools = () => [];
  const manager = SessionManager.inMemory(notes);
  loaded.runtime.appendEntry = (type, data) =>
    manager.appendCustomEntry(type, data);
  const ctx = {
    cwd: notes,
    sessionManager: manager,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      getEditorText: () => "",
      notify: (text, level) => {
        notices.push(text);
        notifications.push({ text, level });
      },
      setStatus: (_key, text) => statuses.push(text),
    },
  };
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of extension.handlers.get(name) || [])
      results.push(
        await handler(
          { type: name, input: {}, toolCallId: "fixture", ...event },
          ctx,
        ),
      );
    return results.filter(Boolean);
  };
  const command = (args) => extension.commands.get("comms").handler(args, ctx);
  const store = new Store(join(directory, "comms"));
  return {
    ...fake,
    directory,
    loaded,
    extension,
    ctx,
    events,
    notices,
    notifications,
    statuses,
    prompts,
    emit,
    command,
    store,
  };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture condition never completed");
}

test("cancellation waits for owned descendants after their leader exits", async (t) => {
  const fake = fakeClaude(t, { wait: true, descendant: true });
  const controller = new AbortController();
  const running = runClaudeTriage(
    request(fake.dir, { signal: controller.signal }),
  );
  const rejected = assert.rejects(running, /cancelled/);
  await waitFor(join(fake.dir, "descendant-pid"));
  const pid = Number(readFileSync(join(fake.dir, "descendant-pid"), "utf8"));
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("default refresh runs Claude without touching the Pi prompt or blocking parent tools", async (t) => {
  const h = await externalHarness(t);
  h.ctx.isIdle = () => false;
  h.ctx.ui.getEditorText = () => "My existing prompt";
  await h.command("refresh");
  assert.equal(h.prompts.length, 0);
  assert.ok(existsSync(join(h.store.directory, "triage.lock")));
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "bash",
      input: { command: "git status" },
    }),
    [],
  );
  await h.emit("agent_settled"); // Parent settlement must not cancel external work.
  await until(() => !existsSync(join(h.store.directory, "triage.lock")));
  assert.equal(h.store.read().items.length, 1);
  assert.equal(h.store.read().coverage.length, 4);
  assert.ok(h.statuses.some((text) => text.includes("Claude triage finished")));
  assert.equal(h.ctx.ui.getEditorText(), "My existing prompt");
  const call = JSON.parse(readFileSync(join(h.dir, "request.json"), "utf8"));
  assert.doesNotMatch(call.prompt, /CANONICAL-MEETING-REFERENCE/);
  assert.match(call.prompt, /Meeting notes are not a Comms source/);
});

test("default Claude refresh imports explicit resolutions into the real extension store", async (t) => {
  const h = await externalHarness(t, {
    data: { results: [result({ items: [], resolutions: [resolution()] })] },
  });
  h.store.update((state) =>
    ingest(
      state,
      "mail",
      "work@example.invalid",
      [item()],
      "complete",
      "prior",
      first,
    ),
  );
  await h.command("refresh");
  await until(() => !existsSync(join(h.store.directory, "triage.lock")));
  assert.equal(h.store.read().items[0].status, "resolved");
  assert.deepEqual(h.store.read().items[0].resolution, resolution());
  assert.equal(h.prompts.length, 0);
});

test("Pi-native refresh applies the shared resolution contract and protects its run-start context", async (t) => {
  for (const edited of [false, true]) {
    await t.test(
      edited ? "concurrent edit" : "unchanged request",
      async (t) => {
        const h = await externalHarness(t);
        h.store.update((state) =>
          ingest(
            state,
            "mail",
            "work@example.invalid",
            [item()],
            "complete",
            "prior",
            first,
          ),
        );
        await h.command("refresh pi");
        const prompt = h.prompts[0];
        for (const rule of [
          "return resolutions",
          "evidenceId",
          "evidenceAt",
          "no outstanding promise",
          "Never merely omit",
        ])
          assert.ok(prompt.includes(rule), rule);
        if (edited)
          h.store.update((state) =>
            setDraft(state, state.items[0].key, 0, "Concurrent draft"),
          );
        const tool = h.extension.tools.get("comms_ingest");
        const args = {
          runId: prompt.match(/Run ID: ([\w-]+)/)[1],
          ...result({ items: [], resolutions: [resolution()] }),
        };
        assert.equal(Check((tool.definition ?? tool).parameters, args), true);
        await (tool.definition ?? tool).execute("fixture", args);
        const saved = h.store.read().items[0];
        assert.equal(saved.status, edited ? "open" : "resolved");
        assert.equal(saved.draft, edited ? "Concurrent draft" : "");
        await h.emit("agent_settled");
      },
    );
  }
});

test("repeated refresh shows progress without another worker and cancellation leaves the queue unchanged", async (t) => {
  const h = await externalHarness(t, { wait: true });
  h.store.update((state) =>
    ingest(state, "mail", "a", [item()], "complete", "prior", first),
  );
  const before = readFileSync(h.store.file, "utf8");
  await h.command("refresh");
  await waitFor(join(h.dir, "pid"));
  const pid = readFileSync(join(h.dir, "pid"), "utf8");
  for (const command of ["refresh", "refresh pi"]) {
    await h.command(command);
    assert.equal(h.notifications.at(-1).level, "info");
    assert.match(
      h.notifications.at(-1).text,
      /Claude triage.*tool calls|Claude triage starting/,
    );
    assert.match(
      h.notifications.at(-1).text,
      /already running.*\/comms cancel/s,
    );
  }
  assert.equal(readFileSync(join(h.dir, "pid"), "utf8"), pid);
  assert.equal(h.prompts.length, 0);
  const tool = h.extension.tools.get("comms_ingest");
  await assert.rejects(
    () => (tool.definition ?? tool).execute("test", { runId: "invented" }),
    /fresh/,
  );
  await h.command("cancel");
  await until(() => !existsSync(join(h.store.directory, "triage.lock")));
  assert.equal(readFileSync(h.store.file, "utf8"), before);
  await h.command("status");
  assert.ok(h.notices.some((text) => text.includes("triage cancelled")));
});

test("session shutdown waits for the owned Claude worker and releases its lock", async (t) => {
  const h = await externalHarness(t, { wait: true });
  await h.command("refresh");
  await waitFor(join(h.dir, "pid"));
  const pid = Number(readFileSync(join(h.dir, "pid"), "utf8"));
  const count = h.notices.length;
  await h.emit("session_shutdown");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(join(h.store.directory, "triage.lock")), false);
  assert.equal(h.notices.length, count);
  assert.equal(h.store.read().items.length, 0);
});

test("plan mode prevents Claude from starting", async (t) => {
  const h = await externalHarness(t);
  h.events.emit("dotfiles:plan-mode", true);
  await h.command("refresh");
  assert.ok(h.notices.some((text) => text.includes("Leave /plan mode")));
  assert.equal(h.notifications.at(-1).level, "error");
  assert.ok(!h.notifications.at(-1).text.startsWith("Error:"));
  assert.equal(existsSync(join(h.dir, "request.json")), false);
});

test("failed external runs retain the last queue and expose failure status", async (t) => {
  const h = await externalHarness(t, { malformed: true });
  h.store.update((state) =>
    ingest(state, "mail", "a", [item()], "complete", "prior", first),
  );
  const before = readFileSync(h.store.file, "utf8");
  await h.command("refresh");
  await until(() => !existsSync(join(h.store.directory, "triage.lock")));
  assert.equal(readFileSync(h.store.file, "utf8"), before);
  assert.ok(h.statuses.some((text) => text.includes("invalid event stream")));
  assert.ok(h.statuses.every((text) => !text.startsWith("Error:")));
});

test("help and invalid arguments show guidance without starting work or reporting an error", async (t) => {
  const h = await externalHarness(t);
  for (const command of [
    " help ",
    "--help",
    "-h",
    "refresh claude",
    "unknown",
  ]) {
    await h.command(command);
    const notice = h.notifications.at(-1);
    assert.equal(
      notice.level,
      ["refresh claude", "unknown"].includes(command) ? "warning" : "info",
    );
    assert.match(notice.text, /Comms commands:/);
    assert.match(notice.text, /\/comms refresh pi/);
    assert.ok(!notice.text.startsWith("Error:"));
  }
  assert.equal(existsSync(join(h.dir, "request.json")), false);
  assert.equal(existsSync(h.store.file), false);
  assert.equal(h.prompts.length, 0);
});

test("whitespace is normalized and Pi-native busy guidance never promises Claude cancellation", async (t) => {
  const h = await externalHarness(t);
  await h.command("  refresh \t pi  ");
  assert.equal(h.prompts.length, 1);
  for (const command of ["refresh", "refresh pi", "cancel"]) {
    await h.command(command);
    assert.equal(h.notifications.at(-1).level, "info");
    assert.match(h.notices.at(-1), /Pi-native triage.*Press Escape/);
    assert.match(h.notices.at(-1), /\/comms cancel only stops Claude triage/);
  }
  assert.equal(h.prompts.length, 1);
  assert.equal(existsSync(join(h.dir, "request.json")), false);
  assert.ok(
    (await h.emit("tool_call", { toolName: "bash" })).some(
      (result) => result.block,
    ),
  );
  const tool = h.extension.tools.get("comms_ingest");
  const saved = await (tool.definition ?? tool).execute("fixture", {
    runId: h.prompts[0].match(/Run ID: ([\w-]+)/)[1],
    ...result({ items: [item(), item()] }),
  });
  assert.equal(JSON.parse(saved.content[0].text).saved, 1);
  assert.equal(h.store.read().items.length, 1);
  await h.emit("agent_settled");
  await h.command(" cancel \t ");
  assert.equal(h.notifications.at(-1).level, "info");
  assert.match(h.notices.at(-1), /No Claude triage is running/);
});

test("draft busy guidance points to Escape without cancelling the Pi job", async (t) => {
  const h = await externalHarness(t);
  writeFileSync(
    join(h.ctx.cwd, ".claude/commands/message.md"),
    "Fixture draft instructions",
  );
  h.store.update((state) =>
    ingest(state, "mail", "work", [item()], "complete", "all", first),
  );
  h.ctx.ui.custom = async () => ({
    action: "draft-ai",
    item: h.store.read().items[0],
    view: { view: 0, search: "" },
  });
  await h.command("");
  assert.equal(h.prompts.length, 1);
  for (const command of ["refresh", "cancel"]) {
    await h.command(command);
    assert.equal(h.notifications.at(-1).level, "info");
    assert.match(h.notices.at(-1), /drafting.*Press Escape/);
  }
  assert.equal(h.prompts.length, 1);
  assert.equal(existsSync(join(h.dir, "request.json")), false);
  await h.emit("agent_settled");
});

test("an already-aborted refresh never starts a process", async (t) => {
  const fake = fakeClaude(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runClaudeTriage(request(fake.dir, { signal: controller.signal })),
  );
  assert.equal(existsSync(join(fake.dir, "request.json")), false);
});

test("default external refresh uses bundled workflows without a notes checkout and keeps model tools inactive", async (t) => {
  const h = await externalHarness(t);
  env(t, "PI_COMMS_NOTES_DIR", "");
  const config = join(h.dir, "public-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      identity: { name: "Synthetic User", timeZone: "Pacific/Auckland" },
      comms: { reminderList: "Synthetic Actions" },
    }),
  );
  env(t, "PI_EXTENSIONS_CONFIG", config);
  await h.command("refresh");
  await until(() =>
    h.statuses.some((status) => status.startsWith("Claude triage finished")),
  );
  const call = JSON.parse(readFileSync(join(h.dir, "request.json"), "utf8"));
  assert.equal(call.cwd, root);
  for (const text of [
    "Communication triage",
    "Synthetic User",
    "Pacific/Auckland",
    "Synthetic Actions",
  ])
    assert.ok(call.prompt.includes(text), text);
  assert.doesNotMatch(
    call.prompt,
    /Fixture canonical instructions|CANONICAL-MEETING-REFERENCE/,
  );
  assert.equal(h.store.read().items.length, 1);
  assert.deepEqual(h.loaded.runtime.getActiveTools(), ["read", "bash"]);
});
