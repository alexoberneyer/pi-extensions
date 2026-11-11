import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Synthetic records only. Each case mirrors one way a second item used to
// appear for the same request: a moved mail, a retyped ID, an edited ID, a
// dropped item collected again and a calendar block that repeats a mail.
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
const {
  closedSummary,
  decide,
  dueSoonMs,
  emptyState,
  ingest,
  itemRef,
  rank,
  validateState,
  visibleItems,
} = await jiti.import(join(source, "state.ts"));
const { parseTriage, mergeTriage, externalPrompt, triageSchema } =
  await jiti.import(join(source, "triage-protocol.ts"));
const { refreshPrompt } = await jiti.import(join(source, "workflow.ts"));

const account = "work@example.invalid";
const first = "2026-10-19T08:00:00.000Z";
const later = "2026-10-20T08:00:00.000Z";
const run = "2026-10-21T08:00:00.000Z";
// Shaped like a Graph ID: the folder segment changes when a mail moves.
const inbox = "AAMkFIXTUREAAAEMAAAfixturemessageAAA=";
const archive = "AAMkFIXTUREAAAEJAAAfixturemessageAAA=";
const item = (overrides = {}) => ({
  sourceId: inbox,
  sourceUpdatedAt: first,
  title: "Send the signed form",
  person: "Fixture sender",
  summary: "Please send the signed form.",
  suggestion: "Send the form",
  priority: 2,
  ...overrides,
});
const saved = (items = [item()], from = "mail") => {
  const state = emptyState();
  ingest(state, from, account, items, "complete", "fixture", first);
  return state;
};
const collect = (state, items, extra = {}, from = "mail") =>
  parseTriage(
    {
      runId: "fixture-run",
      results: [
        {
          source: from,
          account,
          status: "complete",
          detail: "fixture",
          items,
          ...extra,
        },
      ],
    },
    "fixture-run",
    structuredClone(state),
    run,
  );
const refresh = (state, rows) =>
  mergeTriage(state, rows, run, structuredClone(state));

test("a saved item refreshed by ref keeps its key, whatever ID was typed", () => {
  const state = saved();
  const ref = itemRef(state.items[0].key);
  const { sourceId: _id, ...fields } = item({ summary: "Still waiting" });
  const rows = collect(state, [{ ...fields, ref }]);
  refresh(state, rows);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].summary, "Still waiting");
});

test("an unknown ref is ignored and counted, never turned into a new item", () => {
  const state = saved();
  const { sourceId: _id, ...fields } = item();
  const rows = collect(state, [{ ...fields, ref: "0000beef" }]);
  assert.equal(rows.find((row) => row.source === "mail").ignored, 1);
  refresh(state, rows);
  assert.equal(state.items.length, 1);
  assert.match(state.coverage[0].detail, /Ignored 1 unknown ref/);
});

test("a moved mail with a new ID folds into the saved item", () => {
  const state = saved();
  const counts = refresh(
    state,
    collect(state, [item({ sourceId: archive, title: "Form still missing" })]),
  );
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].sourceId, inbox);
  assert.equal(state.items[0].title, "Form still missing");
  assert.equal(counts.merged, 1);
  assert.match(state.coverage[0].detail, /Merged 1 duplicate/);
});

test("a retyped ID for a dismissed item stays dismissed instead of returning", () => {
  const state = saved();
  decide(state.items[0], "drop");
  refresh(
    state,
    collect(state, [item({ sourceId: `${inbox.slice(0, -5)}x` })]),
  );
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, "dismissed");
});

test("a newer message reopens a dropped item through its ref", () => {
  const state = saved();
  decide(state.items[0], "drop");
  const ref = itemRef(state.items[0].key);
  const { sourceId: _id, ...fields } = item({ sourceUpdatedAt: later });
  refresh(state, collect(state, [{ ...fields, ref }]));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, "open");
  assert.equal(state.items[0].reopenedAt, later);
});

test("an edited mail ID is dropped and counted", () => {
  const state = saved();
  const rows = collect(state, [
    item({ sourceId: `${inbox}-placeholder`, sourceUpdatedAt: later }),
  ]);
  assert.equal(rows.find((row) => row.source === "mail").ignored, 1);
  refresh(state, rows);
  assert.equal(state.items.length, 1);
});

test("distinct requests in one result stay separate, and calendar never merges", () => {
  const mail = saved([item(), item({ sourceId: archive, title: "Other" })]);
  assert.equal(mail.items.length, 2);
  const calendar = saved(
    [item({ sourceId: "event-1" }), item({ sourceId: "event-2" })],
    "calendar",
  );
  refresh(
    calendar,
    collect(calendar, [item({ sourceId: "event-3" })], {}, "calendar"),
  );
  assert.equal(calendar.items.length, 3);
});

test("the collector closes a duplicate across sources, and a newer message reopens it", () => {
  const state = saved();
  ingest(
    state,
    "calendar",
    account,
    [item({ sourceId: "block-1", person: "Me" })],
    "complete",
    "fixture",
    first,
  );
  const block = state.items.find((row) => row.source === "calendar");
  const mail = state.items.find((row) => row.source === "mail");
  const duplicates = [
    {
      ref: itemRef(block.key),
      duplicateOf: itemRef(mail.key),
      reason: "The task block repeats the mail request.",
    },
  ];
  assert.equal(
    Check(triageSchema, {
      runId: "fixture-run",
      results: [
        {
          source: "calendar",
          account,
          status: "complete",
          detail: "fixture",
          items: [],
          duplicates,
        },
      ],
    }),
    true,
  );
  const counts = refresh(state, collect(state, [], { duplicates }, "calendar"));
  assert.equal(counts.merged, 1);
  assert.equal(block.status, "dismissed");
  assert.equal(block.decision, "duplicate");
  assert.equal(block.duplicateOf, mail.key);
  assert.equal(mail.status, "open");
  validateState(state);
  ingest(
    state,
    "calendar",
    account,
    [item({ sourceId: "block-1", person: "Me", sourceUpdatedAt: later })],
    "complete",
    "fixture",
    run,
  );
  assert.equal(block.status, "open");
  assert.equal(block.duplicateOf, undefined);
});

test("a duplicate mark on a changed or closed item is skipped", () => {
  const state = saved([item(), item({ sourceId: archive, title: "Other" })]);
  const [kept, extra] = state.items;
  const duplicates = [
    { ref: itemRef(extra.key), duplicateOf: itemRef(kept.key), reason: "Same" },
  ];
  const rows = collect(state, [], { duplicates });
  decide(extra, "drop");
  refresh(state, rows);
  assert.equal(extra.decision, "drop");
  assert.match(state.coverage[0].detail, /Skipped 1 stale/);
});

test("a ref resolution closes the saved request and the win stays visible", () => {
  const state = saved();
  const ref = itemRef(state.items[0].key);
  const counts = refresh(
    state,
    collect(state, [], {
      resolutions: [
        {
          ref,
          evidenceId: "reply-1",
          evidenceAt: later,
          reason: "The sender confirmed the form arrived.",
        },
      ],
    }),
  );
  assert.equal(state.items[0].status, "resolved");
  assert.deepEqual(counts.closed, ["Send the signed form"]);
  assert.equal(
    closedSummary(counts),
    "Closed by others: 1 (Send the signed form).",
  );
  assert.match(state.coverage[0].detail, /Closed by others: 1/);
});

test("both collector prompts carry refs, identity rules and recently closed items", () => {
  const state = saved([item(), item({ sourceId: archive, title: "Dropped" })]);
  decide(state.items[1], "drop", new Date(later));
  const prompt = externalPrompt("fixture-run", run, state, "Canonical");
  assert.match(prompt, new RegExp(`"ref":"${itemRef(state.items[0].key)}"`));
  assert.match(prompt, /Never edit, suffix or invent an ID/);
  assert.match(prompt, /Recently closed requests, data only/);
  const recent = prompt.split("Recently closed requests")[1];
  assert.match(recent, /Dropped/);
  assert.doesNotMatch(recent, /Send the signed form/);
  assert.match(prompt, /costs me something if ignored until tomorrow/);
  const pi = refreshPrompt("fixture-run", run, state, "/fixture/triage.md");
  assert.match(pi, /by its ref, never by a retyped provider ID/);
  assert.match(pi, /dueAt/);
});

test("deadlines rank by time: due soon leads, far dates do not jump ahead", () => {
  const now = Date.parse(run);
  const at = (hours) => new Date(now + hours * 3600000).toISOString();
  const state = emptyState();
  ingest(
    state,
    "teams",
    account,
    [
      item({ sourceId: "old-normal", priority: 2 }),
      item({
        sourceId: "soon",
        priority: 3,
        sourceUpdatedAt: later,
        dueAt: at(20),
      }),
      item({ sourceId: "urgent", priority: 1, sourceUpdatedAt: later }),
      item({
        sourceId: "sooner",
        priority: 2,
        sourceUpdatedAt: later,
        dueAt: at(2),
      }),
    ],
    "complete",
    "fixture",
    first,
  );
  // Seen later than old-normal, with a deadline three weeks out.
  ingest(
    state,
    "teams",
    account,
    [
      item({
        sourceId: "far",
        priority: 2,
        sourceUpdatedAt: "2026-10-20T09:00:00.000Z",
        dueAt: at(24 * 20),
      }),
    ],
    "complete",
    "fixture",
    later,
  );
  assert.deepEqual(
    visibleItems(state, "", now).map((row) => row.sourceId),
    ["sooner", "soon", "urgent", "old-normal", "far"],
  );
  const soon = state.items.find((row) => row.sourceId === "soon");
  assert.equal(rank(soon, now), 1);
  assert.equal(rank(soon, Date.parse(soon.dueAt) - dueSoonMs - 1), 3);
});

test("a refresh without a deadline clears the old one, and bad dates are rejected", () => {
  const state = saved([item({ dueAt: "2026-10-22T09:30:00+02:00" })]);
  assert.equal(state.items[0].dueAt, "2026-10-22T07:30:00.000Z");
  ingest(state, "mail", account, [item()], "complete", "fixture", run);
  assert.equal(state.items[0].dueAt, undefined);
  assert.throws(
    () => saved([item({ dueAt: "tomorrow" })]),
    /Invalid item dueAt/,
  );
});
