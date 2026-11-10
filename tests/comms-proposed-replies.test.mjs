import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const { emptyState, ingest, setDraft, validateState } = await jiti.import(
  join(source, "state.ts"),
);
const { Store } = await jiti.import(join(source, "store.ts"));
const {
  candidateSchema,
  triageSchema,
  parseTriage,
  mergeTriage,
  externalPrompt,
} = await jiti.import(join(source, "triage-protocol.ts"));
const { refreshPrompt, triageDraftingInstructions } = await jiti.import(
  join(source, "workflow.ts"),
);

const first = "2026-10-19T08:00:00.000Z";
const second = "2026-10-19T09:00:00.000Z";
const third = "2026-10-19T10:00:00.000Z";
const account = "synthetic-user@example.invalid";
const reply = "Die Testunterlagen liegen im verlinkten Beispielordner.";
const candidate = (changes = {}) => ({
  sourceId: "synthetic-request",
  sourceUpdatedAt: first,
  title: "Where are the synthetic documents?",
  person: "Synthetic Colleague",
  summary:
    "The exact thread links the example folder containing the test documents.",
  suggestion:
    "Review the local reply and answer with the verified folder location.",
  priority: 2,
  ...changes,
});
const result = (changes = {}) => ({
  source: "mail",
  account,
  status: "complete",
  detail: "Synthetic read-only collection, all pages checked.",
  items: [candidate({ proposedReply: reply })],
  ...changes,
});
const payload = (rows = [result()]) => ({
  runId: "synthetic-run",
  results: rows,
});
function collect(state, items, startedAt = first, snapshot, source = "mail") {
  ingest(
    state,
    source,
    account,
    items,
    "complete",
    "Synthetic collection",
    startedAt,
    [],
    snapshot,
  );
}
function existing() {
  const state = emptyState();
  collect(state, [candidate()]);
  return state;
}
function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "comms-proposed-replies-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new Store(join(directory, "queue"));
}

test("the shared collector schema accepts optional bounded plain-text proposals", () => {
  assert.equal(Check(candidateSchema, candidate()), true);
  for (const proposedReply of ["", reply, "x".repeat(20000)]) {
    assert.equal(Check(candidateSchema, candidate({ proposedReply })), true);
    assert.equal(
      Check(
        triageSchema,
        payload([result({ items: [candidate({ proposedReply })] })]),
      ),
      true,
    );
  }
  for (const proposedReply of [null, false, 123, {}, [], "x".repeat(20001)]) {
    assert.equal(Check(candidateSchema, candidate({ proposedReply })), false);
    assert.equal(
      Check(
        triageSchema,
        payload([result({ items: [candidate({ proposedReply })] })]),
      ),
      false,
    );
  }
});

test("external parse and merge seed new mail and Teams drafts without persisting proposals", (t) => {
  const store = temporaryStore(t);
  const snapshot = store.read();
  const rows = parseTriage(
    payload([result(), result({ source: "teams", status: "partial" })]),
    "synthetic-run",
    snapshot,
    second,
  );
  assert.equal(rows[0].items[0].proposedReply, reply);
  assert.equal(rows[1].items[0].proposedReply, reply);
  const saved = store.update((state) =>
    mergeTriage(state, rows, second, snapshot),
  );
  assert.equal(saved.version, 1);
  assert.equal(saved.items.length, 2);
  for (const item of store.read().items) {
    assert.equal(item.draft, reply);
    assert.equal(item.draftRevision, 1);
    assert.equal(item.draftStale, false);
    assert.equal(item.status, "open");
    assert.equal(item.resolution, undefined);
    assert.equal(Object.hasOwn(item, "proposedReply"), false);
  }
  assert.doesNotMatch(readFileSync(store.file, "utf8"), /proposedReply/);
});

test("Pi-native shared ingestion sanitizes proposals without the default 12,000-character truncation", () => {
  const state = emptyState();
  const proposedReply = `\x1b[31m${"x".repeat(19990)}\nEnd\u202e`;
  assert.equal(Check(candidateSchema, candidate({ proposedReply })), true);
  collect(state, [candidate({ proposedReply })], second, emptyState(), "teams");
  assert.equal(state.items[0].draft, `${"x".repeat(19990)}\nEnd`);
  assert.equal(Object.hasOwn(state.items[0], "proposedReply"), false);
  assert.equal(validateState(state), state);
  const boundary = emptyState();
  collect(boundary, [candidate({ proposedReply: "x".repeat(20000) })]);
  assert.equal(boundary.items[0].draft.length, 20000);
});

test("legacy candidates and blank proposals leave new drafts empty", () => {
  for (const changes of [
    {},
    { proposedReply: "" },
    { proposedReply: " \n\t\x1b[31m " },
  ]) {
    const state = emptyState();
    collect(state, [candidate(changes)]);
    assert.equal(state.items[0].draft, "");
    assert.equal(state.items[0].draftRevision, 0);
    assert.equal(Object.hasOwn(state.items[0], "proposedReply"), false);
  }
});

test("only run-start-unchanged, untouched empty existing items receive a proposal", () => {
  for (const sourceUpdatedAt of [first, second]) {
    const state = existing();
    const snapshot = structuredClone(state);
    const oldRevision = state.items[0].draftRevision;
    collect(
      state,
      [candidate({ sourceUpdatedAt, proposedReply: reply })],
      second,
      snapshot,
    );
    assert.equal(state.items[0].draft, reply);
    assert.ok(state.items[0].draftRevision > oldRevision);
    assert.equal(state.items[0].draftStale, false);
    assert.equal(state.items[0].sourceUpdatedAt, sourceUpdatedAt);
    assert.throws(
      () => setDraft(state, state.items[0].key, oldRevision, "Old editor"),
      /changed/,
    );
    assert.deepEqual(snapshot.items[0].draft, "");
  }
  const state = existing();
  collect(state, [candidate({ proposedReply: reply })], second);
  assert.equal(
    state.items[0].draft,
    "",
    "No snapshot cannot prove an existing item was untouched",
  );
});

test("saved drafts, manual clearing, stale flags and local routing/status are never replaced by proposals", () => {
  for (const changes of [
    { draft: "My saved reply", draftRevision: 1 },
    { draft: "Pre-existing version-1 reply", draftRevision: 0 },
    { draft: " ", draftRevision: 0 },
    { draft: "", draftRevision: 1 },
    { draft: "Old context", draftRevision: 3, draftStale: true },
    { draft: "", draftStale: true },
    { reminderAdded: "Synthetic accepted action" },
    { snoozedUntil: third },
    { status: "waiting" },
    { status: "resolved" },
    { status: "dismissed" },
  ]) {
    const state = existing();
    Object.assign(state.items[0], changes);
    const snapshot = structuredClone(state);
    collect(state, [candidate({ proposedReply: reply })], second, snapshot);
    assert.deepEqual(state.items, snapshot.items, JSON.stringify(changes));
  }
});

test("deliberately cleared replies stay empty even after newer source evidence and later runs", () => {
  const state = existing();
  setDraft(state, state.items[0].key, 0, "A reviewed reply");
  setDraft(state, state.items[0].key, 1, "");
  for (const stamp of [second, third]) {
    collect(
      state,
      [candidate({ sourceUpdatedAt: stamp, proposedReply: reply })],
      stamp,
      structuredClone(state),
    );
    assert.equal(state.items[0].draft, "");
    assert.ok(state.items[0].draftRevision >= 2);
  }
});

test("source refresh preserves saved wording and cannot clear an existing stale flag", () => {
  for (const draft of ["", "Reviewed but stale reply"]) {
    const state = existing();
    Object.assign(state.items[0], { draft, draftStale: true });
    collect(
      state,
      [candidate({ sourceUpdatedAt: second, proposedReply: reply })],
      second,
      structuredClone(state),
    );
    assert.equal(state.items[0].draft, draft);
    assert.equal(state.items[0].draftStale, true);
  }
  const state = existing();
  setDraft(state, state.items[0].key, 0, "Reviewed reply");
  collect(
    state,
    [candidate({ sourceUpdatedAt: second, proposedReply: reply })],
    second,
    structuredClone(state),
  );
  assert.equal(state.items[0].draft, "Reviewed reply");
  assert.equal(state.items[0].draftStale, true);
});

test("external merging preserves concurrent edits, clears, status and source assessments under the store lock", (t) => {
  for (const mutate of [
    (state) =>
      setDraft(state, state.items[0].key, 0, "Concurrent reviewed reply"),
    (state) => setDraft(state, state.items[0].key, 0, ""),
    (state) => {
      state.items[0].status = "waiting";
    },
    (state) => {
      state.items[0].status = "resolved";
    },
    (state) => {
      state.items[0].status = "dismissed";
    },
    (state) => {
      state.items[0].snoozedUntil = third;
    },
    (state) => {
      state.items[0].reminderAdded = "Concurrent accepted action";
    },
    (state) => {
      state.items[0].summary =
        "Newer assessment at the same provider timestamp";
    },
    (state) => {
      state.items[0].uncertainty = "A new missing check";
    },
    (state) => {
      state.items = [];
    },
    (state) => collect(state, [candidate({ sourceUpdatedAt: third })], third),
    (state) => {
      collect(state, [candidate({ sourceUpdatedAt: second })], second);
      state.items[0].status = "dismissed";
    },
  ]) {
    const store = temporaryStore(t);
    const snapshot = store.update((state) => collect(state, [candidate()]));
    const rows = parseTriage(
      payload([
        result({
          items: [candidate({ sourceUpdatedAt: second, proposedReply: reply })],
        }),
      ]),
      "synthetic-run",
      snapshot,
      second,
    );
    const changed = store.update(mutate);
    const merged = store.update((state) =>
      mergeTriage(state, rows, second, snapshot),
    );
    const before = changed.items[0];
    const after = merged.items[0];
    if (before && Date.parse(before.sourceUpdatedAt) < Date.parse(second)) {
      assert.equal(after.sourceUpdatedAt, second);
      assert.equal(after.draft, before.draft);
      assert.equal(
        after.draftStale,
        before.draftStale || Boolean(before.draft),
      );
      assert.equal(after.draftRevision, before.draftRevision + 1);
      assert.equal(after.status, before.status);
      assert.equal(after.snoozedUntil, before.snoozedUntil);
      assert.equal(after.reminderAdded, before.reminderAdded);
      assert.equal(after.summary, candidate().summary);
      assert.equal(after.uncertainty, undefined);
      assert.equal(Object.hasOwn(after, "proposedReply"), false);
      assert.equal(merged.coverage[0].cursor, second);
    } else {
      assert.deepEqual(merged.items, changed.items);
    }
  }
});

test("an item added concurrently is not treated as new or untouched by the older run", () => {
  const snapshot = emptyState();
  const state = existing();
  const before = structuredClone(state.items);
  const rows = parseTriage(payload(), "synthetic-run", snapshot, second);
  mergeTriage(state, rows, second, snapshot);
  assert.deepEqual(state.items, before);
});

test("a newer source/account collection prevents delayed proposals even when an item is unchanged", () => {
  for (const present of [false, true]) {
    const state = present ? existing() : emptyState();
    const snapshot = structuredClone(state);
    collect(state, [], third);
    collect(state, [candidate({ proposedReply: reply })], second, snapshot);
    assert.equal(state.items[0].draft, "");
    assert.equal(state.coverage[0].checkedAt, third);
  }
});

test("unsupported sources keep actionable items but ignore otherwise valid proposals", () => {
  for (const source of ["calendar", "notion"]) {
    const state = emptyState();
    const items = [candidate({ proposedReply: reply })];
    const rows = parseTriage(
      payload([result({ source, items })]),
      "synthetic-run",
      state,
      second,
    );
    assert.equal(rows[0].status, "complete");
    mergeTriage(state, rows, second, emptyState());
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].draft, "");
    assert.equal(Object.hasOwn(state.items[0], "proposedReply"), false);
    assert.equal(validateState(state), state);
  }
});

test("open-ask uncertainty keeps its proposal, with counts that show what was seeded", () => {
  const snapshot = emptyState();
  const rows = parseTriage(
    payload([
      result({
        items: [
          candidate({
            proposedReply: reply,
            uncertainty:
              "A colleague may already have answered in the channel.",
          }),
        ],
      }),
    ]),
    "synthetic-run",
    snapshot,
    second,
  );
  const state = emptyState();
  assert.deepEqual(mergeTriage(state, rows, second, snapshot), {
    proposals: 1,
    seeded: 1,
  });
  assert.equal(state.items[0].draft, reply.trim());
  assert.equal(state.items[0].draftOrigin, "triage");
  assert.equal(
    state.items[0].uncertainty,
    "A colleague may already have answered in the channel.",
  );
  assert.match(state.coverage[0].detail, /^Drafts: 1 of 1 proposals seeded\./);
});

test("unverified accounts and blockers cannot create local drafts", () => {
  for (const changes of [
    { account: "unverified", status: "partial" },
    {
      items: [
        candidate({
          proposedReply: reply,
          blocker: "Calendar availability has not been checked.",
        }),
      ],
    },
    {
      items: [
        candidate({
          proposedReply: reply,
          blocker: "The user must choose between two options.",
        }),
      ],
    },
  ]) {
    const snapshot = emptyState();
    const rows = parseTriage(
      payload([result(changes)]),
      "synthetic-run",
      snapshot,
      second,
    );
    assert.notEqual(rows[0].status, "unavailable");
    const state = emptyState();
    const counts = mergeTriage(state, rows, second, snapshot);
    assert.equal(counts.seeded, 0);
    assert.equal(state.items[0].draft, "");
    assert.equal(state.items[0].draftOrigin, undefined);
    assert.equal(state.items[0].blocker, changes.items?.[0].blocker);
    assert.equal(state.items[0].suggestion, candidate().suggestion);
  }
  for (const changes of [
    { account: "unverified", status: "complete" },
    { status: "unavailable" },
  ]) {
    const rows = parseTriage(
      payload([result(changes)]),
      "synthetic-run",
      emptyState(),
      second,
    );
    assert.equal(rows[0].status, "unavailable");
    assert.deepEqual(rows[0].items, []);
  }
});

test("malformed or oversized proposals reject only their source/account and preserve its cursor and drafts", () => {
  for (const proposedReply of [null, false, {}, [], "x".repeat(20001)]) {
    const state = existing();
    setDraft(state, state.items[0].key, 0, "Reviewed saved wording");
    const snapshot = structuredClone(state);
    const items = [
      candidate({ sourceId: "new" }),
      candidate({ proposedReply }),
    ];
    assert.throws(
      () => collect(state, items, second, snapshot),
      /proposedReply/,
    );
    assert.deepEqual(state, snapshot);
    const rows = parseTriage(
      payload([result({ items }), result({ source: "teams" })]),
      "synthetic-run",
      snapshot,
      second,
    );
    assert.equal(rows[0].status, "unavailable");
    assert.match(rows[0].detail, /proposedReply/);
    mergeTriage(state, rows, second, snapshot);
    assert.deepEqual(state.items[0], snapshot.items[0]);
    assert.equal(
      state.coverage.find((row) => row.source === "mail").cursor,
      first,
    );
    assert.equal(state.items[1].source, "teams");
    assert.equal(state.items[1].draft, reply);
  }
});

test("conflicting duplicate proposals fail closed before any candidate imports", () => {
  const state = emptyState();
  assert.throws(
    () =>
      collect(state, [
        candidate({ proposedReply: reply }),
        candidate({ proposedReply: "A contradictory reply" }),
      ]),
    /Conflicting duplicate/,
  );
  assert.deepEqual(state, emptyState());
});

test("version-1 persisted local drafts are not validated as collector proposals", (t) => {
  const store = temporaryStore(t);
  store.update((state) => {
    for (const source of ["mail", "teams", "calendar", "notion"])
      ingest(
        state,
        source,
        "unverified",
        [candidate({ uncertainty: "A missing check remains." })],
        "partial",
        "Legacy synthetic queue",
        first,
      );
    for (const item of state.items) {
      setDraft(state, item.key, item.draftRevision, "x".repeat(20000));
      item.draftStale = true;
    }
  });
  const loaded = store.read();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.items.length, 4);
  for (const item of loaded.items) {
    assert.equal(item.draft.length, 20000);
    assert.equal(item.draftStale, true);
    assert.equal(item.uncertainty, "A missing check remains.");
    assert.equal(Object.hasOwn(item, "proposedReply"), false);
  }
});

test("both collector prompts require selective local proposals, concrete actions and unchanged read-only boundaries", () => {
  const state = existing();
  state.items[0].draft = "SYNTHETIC-SAVED-WORDING-NOT-FOR-COLLECTION";
  for (const prompt of [
    externalPrompt(
      "synthetic-run",
      second,
      state,
      "Synthetic canonical filters",
    ),
    refreshPrompt("synthetic-run", second, state, "/synthetic/triage.md"),
  ]) {
    assert.ok(prompt.includes(triageDraftingInstructions()));
    for (const text of [
      "Always include a concrete suggested action",
      "proposedReply ONLY",
      "mail or teams",
      "verified account",
      "exact thread and recipient",
      "with no blocker",
      "Residual uncertainty about whether the ask is still open does not prevent a proposal",
      "a decision only I can make in blocker",
      "Never relabel a missing fact or a choice of mine as uncertainty",
      "Keep blockers on retained requests until you have checked them again. Reassess uncertainty on every refresh.",
      "Do not invent facts, deadlines or commitments",
      "plain text",
      "20,000 characters",
      "original language and my terse voice",
      "LOCAL unsent proposal",
      "Otherwise omit proposedReply and name the blocker",
      "Do not copy or replace saved local drafts",
      "create remote drafts",
      "return resolutions",
    ])
      assert.ok(prompt.includes(text), text);
    assert.match(prompt, /(?:Do not|Never) send/);
    assert.doesNotMatch(
      prompt,
      /without drafting replies|leave message generation to|SYNTHETIC-SAVED-WORDING|Preserve unresolved uncertainty|no identified missing checks or uncertainty/,
    );
  }
  const canonical = readFileSync(
    join(root, "workflows/comms/triage.md"),
    "utf8",
  );
  for (const text of [
    "concrete suggested action",
    "proposedReply",
    "verified account",
    "no user decision",
    "original language",
    "terse voice",
    "omit proposedReply",
    "Residual uncertainty does not prevent a proposal",
    "Collection never sends messages, creates remote drafts",
  ])
    assert.ok(canonical.includes(text), text);
});
