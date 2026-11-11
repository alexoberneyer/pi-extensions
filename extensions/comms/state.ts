import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
export const collectionSources = [
  "mail",
  "teams",
  "calendar",
  "notion",
] as const;
// Comms no longer collects these. Saved items keep loading and stay actionable.
export const legacySources = ["meetings", "remarkable"] as const;
export const sources = [...collectionSources, ...legacySources] as const;
export type CollectionSource = (typeof collectionSources)[number];
export type Source = (typeof sources)[number];
export type Status = "open" | "waiting" | "resolved" | "dismissed";
// The latest disposition only, not history. Waiting and snooze stay unresolved.
export const decisions = [
  "next",
  "drop",
  "resolve",
  "answered",
  "waiting",
  "snooze",
  "expired",
  "duplicate",
] as const;
export type Decision = (typeof decisions)[number];
export const draftOrigins = ["triage", "ai", "manual"] as const;
export type DraftOrigin = (typeof draftOrigins)[number];
// New collector notes are one short line. Saved records keep the old limit.
export const noteLimit = 300;
const legacyUncertaintyLimit = 2000;
export type Candidate = {
  sourceId: string;
  sourceUpdatedAt: string;
  title: string;
  person: string;
  summary: string;
  // Residual doubt about whether the ask is still open. It does not block a draft.
  uncertainty?: string;
  // Missing facts, unreadable evidence, unverified recipient or ownership, or a
  // decision only the user can make. Any blocker withholds a proposed reply.
  blocker?: string;
  suggestion: string;
  proposedReply?: string;
  priority: number;
  // A stated deadline, or a meeting start for prep. Never invented.
  dueAt?: string;
  url?: string;
};
export type Resolution = {
  sourceId: string;
  sourceUpdatedAt: string;
  evidenceId: string;
  evidenceAt: string;
  reason: string;
};
// Collector input. A saved item is named by its short ref, because long
// provider IDs get mistyped and a typo silently creates a second item.
export type CollectedCandidate = Omit<Candidate, "sourceId"> & {
  sourceId?: string;
  ref?: string;
};
export type CollectedResolution = Omit<
  Resolution,
  "sourceId" | "sourceUpdatedAt"
> & { sourceId?: string; sourceUpdatedAt?: string; ref?: string };
export type CollectedDuplicate = {
  ref: string;
  duplicateOf: string;
  reason: string;
};
// Keys of a saved item to close and the saved item it repeats.
export type Duplicate = { key: string; of: string; reason: string };
export type Item = Omit<Candidate, "proposedReply"> & {
  key: string;
  source: Source;
  account: string;
  status: Status;
  // Hides an open or waiting item until then.
  snoozedUntil?: string;
  draft: string;
  draftRevision: number;
  draftStale: boolean;
  // Provenance only, never evidence of delivery or unchanged use.
  draftOrigin?: DraftOrigin;
  reminderAdded?: string;
  resolution?: Resolution;
  // Optional lifecycle fields. Legacy items stay undated rather than invented.
  firstSeenAt?: string;
  reopenedAt?: string;
  decision?: Decision;
  decidedAt?: string;
  // Key of the saved item this one repeated when a refresh closed it.
  duplicateOf?: string;
  // Legacy scratchpad evidence, kept unchanged on old reMarkable items.
  remarkable?: Record<string, unknown>;
};
export type Coverage = {
  source: Source;
  account: string;
  status: "complete" | "partial" | "unavailable";
  checkedAt: string;
  cursor?: string;
  detail: string;
};
export type State = {
  version: 1;
  revision: number;
  items: Item[];
  coverage: Coverage[];
};
export const emptyState = (): State => ({
  version: 1,
  revision: 0,
  items: [],
  coverage: [],
});

// Terminal escape sequences and invisible directional controls are never stored.
export function clean(value: string, limit = 12000): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, limit);
}
export function errorMessage(error: unknown, limit = 1200): string {
  return clean(error instanceof Error ? error.message : String(error), limit);
}
export function identity(
  source: Source,
  account: string,
  sourceId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([source, account, sourceId]))
    .digest("hex")
    .slice(0, 32);
}
export function itemRef(key: string): string {
  return key.slice(0, 8);
}
function byRef(
  snapshot: State | undefined,
  ref: unknown,
  scope?: { source: Source; account: string },
): Item | undefined {
  if (!snapshot || typeof ref !== "string" || !/^[a-f0-9]{8}$/.test(ref))
    return;
  const matches = snapshot.items.filter(
    (item) =>
      itemRef(item.key) === ref &&
      (!scope ||
        (item.source === scope.source && item.account === scope.account)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export type Collected = {
  items: Candidate[];
  resolutions: Resolution[];
  duplicates: Duplicate[];
  ignored: number;
};
// Turns refs into the saved provider IDs. An unknown ref or an ID the provider
// never issues is dropped and counted, never guessed into a new item.
export function applyRefs(
  source: Source,
  account: string,
  snapshot: State | undefined,
  items: CollectedCandidate[] = [],
  resolutions: CollectedResolution[] = [],
  duplicates: CollectedDuplicate[] = [],
): Collected {
  if (
    !Array.isArray(items) ||
    !Array.isArray(resolutions) ||
    !Array.isArray(duplicates) ||
    duplicates.length > 1000
  )
    throw new Error("Invalid collection result.");
  const scope = { source, account };
  let ignored = 0;
  const known = <T extends { sourceId?: string; ref?: string }>(
    value: T,
  ): (T & { sourceId: string; target?: Item }) | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid collection entry.");
    const { ref, ...rest } = value;
    const target = ref === undefined ? undefined : byRef(snapshot, ref, scope);
    // Graph IDs carry base64 padding only at the end. "=-" marks an edited ID.
    const edited =
      source === "mail" &&
      typeof rest.sourceId === "string" &&
      /=-/.test(rest.sourceId);
    if ((ref !== undefined && !target) || (!target && edited)) {
      ignored++;
      return;
    }
    return (
      target ? { ...rest, sourceId: target.sourceId, target } : rest
    ) as T & { sourceId: string; target?: Item };
  };
  const mapped: Collected = {
    items: [],
    resolutions: [],
    duplicates: [],
    ignored: 0,
  };
  for (const raw of items) {
    const item = known(raw);
    if (!item) continue;
    const { target: _target, ...candidate } = item;
    mapped.items.push(candidate as Candidate);
  }
  for (const raw of resolutions) {
    const resolution = known(raw);
    if (!resolution) continue;
    const { target, ...rest } = resolution;
    mapped.resolutions.push({
      ...rest,
      // The saved request is the one being closed, whatever was retyped.
      ...(target ? { sourceUpdatedAt: target.sourceUpdatedAt } : {}),
    } as Resolution);
  }
  for (const raw of duplicates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid collection entry.");
    const target = byRef(snapshot, raw.ref, scope);
    const of = byRef(snapshot, raw.duplicateOf);
    if (
      !target ||
      !of ||
      target.key === of.key ||
      typeof raw.reason !== "string" ||
      !clean(raw.reason, 300).trim()
    ) {
      ignored++;
      continue;
    }
    mapped.duplicates.push({
      key: target.key,
      of: of.key,
      reason: clean(raw.reason, 300).trim(),
    });
  }
  mapped.ignored = ignored;
  return mapped;
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
export function validateCandidate(
  value: Candidate,
  source?: Source,
  stored = false,
): Candidate {
  for (const key of [
    "sourceId",
    "title",
    "person",
    "summary",
    "suggestion",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length > 12000)
      throw new Error(`Invalid item ${key}.`);
  }
  if (
    !value.sourceId.trim() ||
    value.sourceId.length > 2000 ||
    !value.title.trim() ||
    !validDate(value.sourceUpdatedAt)
  )
    throw new Error(
      "An item needs a stable source ID, title and source timestamp.",
    );
  for (const [field, max] of [
    ["uncertainty", stored ? legacyUncertaintyLimit : noteLimit],
    ["blocker", noteLimit],
  ] as const)
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].length > max)
    )
      throw new Error(
        `Invalid item ${field} (one line, at most ${max} characters).`,
      );
  const line = (text: string, max: number) =>
    clean(text, max).replace(/\s+/g, " ").trim();
  if (
    value.proposedReply !== undefined &&
    (typeof value.proposedReply !== "string" ||
      value.proposedReply.length > 20000)
  )
    throw new Error("Invalid item proposedReply (maximum 20,000 characters).");
  if (![1, 2, 3].includes(value.priority))
    throw new Error("Priority must be 1, 2 or 3.");
  if (value.dueAt !== undefined && !validDate(value.dueAt))
    throw new Error("Invalid item dueAt (ISO 8601 date and time).");
  if (
    value.url !== undefined &&
    (typeof value.url !== "string" ||
      value.url.length > 4000 ||
      !/^https:\/\//i.test(value.url))
  )
    throw new Error("Source links must use HTTPS.");
  return {
    sourceId: clean(value.sourceId, 2000),
    sourceUpdatedAt: new Date(value.sourceUpdatedAt).toISOString(),
    title: clean(value.title, 240),
    person: clean(value.person, 240),
    summary: clean(value.summary),
    ...(value.uncertainty?.trim()
      ? { uncertainty: line(value.uncertainty, legacyUncertaintyLimit) }
      : {}),
    ...(value.blocker?.trim()
      ? { blocker: line(value.blocker, noteLimit) }
      : {}),
    suggestion: clean(value.suggestion, 2000),
    ...(value.proposedReply !== undefined
      ? { proposedReply: clean(value.proposedReply, 20000).trim() }
      : {}),
    priority: value.priority,
    ...(value.dueAt ? { dueAt: new Date(value.dueAt).toISOString() } : {}),
    ...(value.url ? { url: clean(value.url, 4000) } : {}),
  };
}
export function validateCandidates(
  items: Candidate[],
  source: Source,
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const item of items) {
    const candidate = validateCandidate(item, source);
    const previous = byId.get(candidate.sourceId);
    if (previous && !isDeepStrictEqual(previous, candidate))
      throw new Error("Conflicting duplicate request IDs.");
    byId.set(candidate.sourceId, candidate);
  }
  return [...byId.values()];
}
function validateResolution(value: Resolution): Resolution {
  if (!value || typeof value !== "object")
    throw new Error("Invalid request resolution.");
  for (const [field, max] of [
    ["sourceId", 2000],
    ["evidenceId", 2000],
    ["reason", 2000],
  ] as const) {
    if (
      typeof value[field] !== "string" ||
      value[field].length > max ||
      !clean(value[field], max).trim()
    )
      throw new Error(`Invalid resolution ${field}.`);
  }
  if (!validDate(value.sourceUpdatedAt) || !validDate(value.evidenceAt))
    throw new Error(
      "A resolution needs valid request and evidence timestamps.",
    );
  return {
    sourceId: clean(value.sourceId, 2000),
    sourceUpdatedAt: new Date(value.sourceUpdatedAt).toISOString(),
    evidenceId: clean(value.evidenceId, 2000).trim(),
    evidenceAt: new Date(value.evidenceAt).toISOString(),
    reason: clean(value.reason, 2000).trim(),
  };
}
export function validateResolutions(
  resolutions: Resolution[],
  source: Source,
  account: string,
  items: Candidate[],
  previous?: State,
  startedAt?: string,
): Resolution[] {
  if (!Array.isArray(resolutions) || resolutions.length > 1000)
    throw new Error("Invalid request resolutions.");
  if (
    resolutions.length &&
    (!previous ||
      account === "unverified" ||
      !(collectionSources as readonly string[]).includes(source))
  )
    throw new Error(
      "Resolutions require a verified account and run-start queue snapshot.",
    );
  const byId = new Map<string, Resolution>();
  for (const raw of resolutions) {
    const resolution = validateResolution(raw);
    const target = previous!.items.find(
      (item) => item.key === identity(source, account, resolution.sourceId),
    );
    if (
      !target ||
      !["open", "waiting"].includes(target.status) ||
      target.sourceUpdatedAt !== resolution.sourceUpdatedAt
    )
      throw new Error(
        "Resolution must match an outstanding request in the run-start snapshot.",
      );
    if (startedAt && Date.parse(resolution.evidenceAt) > Date.parse(startedAt))
      throw new Error(
        "Resolution evidence is after the collection upper bound.",
      );
    if (items.some((item) => item.sourceId === resolution.sourceId))
      throw new Error("A request cannot be both actionable and resolved.");
    const duplicate = byId.get(resolution.sourceId);
    if (duplicate && !isDeepStrictEqual(duplicate, resolution))
      throw new Error("Conflicting duplicate resolutions.");
    byId.set(resolution.sourceId, resolution);
  }
  return [...byId.values()];
}
export function validateState(value: State): State {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > 2000 ||
    !Array.isArray(value.coverage) ||
    value.coverage.length > 100
  )
    throw new Error(
      "Unsupported or damaged Comms state. The existing file was left intact.",
    );
  const keys = new Set<string>();
  for (const item of value.items) {
    validateCandidate(item, item.source, true);
    if (
      !sources.includes(item.source) ||
      typeof item.account !== "string" ||
      !item.account ||
      item.key !== identity(item.source, item.account, item.sourceId) ||
      keys.has(item.key) ||
      !["open", "waiting", "resolved", "dismissed"].includes(item.status) ||
      typeof item.draft !== "string" ||
      item.draft.length > 20000 ||
      !Number.isSafeInteger(item.draftRevision) ||
      item.draftRevision < 0 ||
      typeof item.draftStale !== "boolean" ||
      (item.snoozedUntil !== undefined && !validDate(item.snoozedUntil)) ||
      (["firstSeenAt", "reopenedAt", "decidedAt"] as const).some(
        (field) => item[field] !== undefined && !validDate(item[field]),
      ) ||
      (item.decision !== undefined && !decisions.includes(item.decision)) ||
      (item.duplicateOf !== undefined &&
        !/^[a-f0-9]{32}$/.test(String(item.duplicateOf))) ||
      (item.draftOrigin !== undefined &&
        !draftOrigins.includes(item.draftOrigin))
    )
      throw new Error("Invalid Comms item. The existing file was left intact.");
    if (item.resolution !== undefined) {
      const resolution = validateResolution(item.resolution);
      if (
        item.source === "remarkable" ||
        resolution.sourceId !== item.sourceId ||
        resolution.sourceUpdatedAt !== item.sourceUpdatedAt
      )
        throw new Error("Invalid saved request resolution.");
    }
    if (item.source === "remarkable") {
      if (
        item.account !== "local-desktop" ||
        item.draft ||
        item.url ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.sourceId)
      )
        throw new Error("Invalid scratchpad review item.");
      if (
        item.remarkable !== undefined &&
        (!item.remarkable ||
          typeof item.remarkable !== "object" ||
          Array.isArray(item.remarkable))
      )
        throw new Error("Invalid scratchpad review item.");
    } else if (item.remarkable !== undefined)
      throw new Error("Scratchpad evidence belongs only to reMarkable items.");
    keys.add(item.key);
  }
  for (const source of value.coverage) {
    if (
      !sources.includes(source.source) ||
      typeof source.account !== "string" ||
      !source.account ||
      !["complete", "partial", "unavailable"].includes(source.status) ||
      !validDate(source.checkedAt) ||
      (source.cursor !== undefined && !validDate(source.cursor)) ||
      typeof source.detail !== "string"
    )
      throw new Error("Invalid Comms source coverage.");
  }
  return value;
}
export function ingest(
  state: State,
  source: Source,
  account: string,
  items: Candidate[],
  status: Coverage["status"],
  detail: string,
  startedAt: string,
  resolutions: Resolution[] = [],
  snapshot?: State,
  extra: { duplicates?: Duplicate[]; ignored?: number } = {},
): ProposalCounts {
  const duplicates = extra.duplicates ?? [];
  if (
    !(collectionSources as readonly string[]).includes(source) ||
    !account.trim() ||
    account.length > 300 ||
    !validDate(startedAt) ||
    !["complete", "partial", "unavailable"].includes(status) ||
    items.length > 1000
  )
    throw new Error("Invalid collection result.");
  if (
    status === "unavailable" &&
    (items.length || resolutions.length || duplicates.length)
  )
    throw new Error("Unavailable sources cannot supply items or resolutions.");
  account = clean(account.trim(), 300);
  if (account === "unverified" && status === "complete")
    throw new Error("Complete coverage requires a verified account identity.");
  const candidates = validateCandidates(items, source);
  const resolved = validateResolutions(
    resolutions,
    source,
    account,
    candidates,
    snapshot,
    startedAt,
  );
  const newerCoverage = state.coverage.some(
    (entry) =>
      entry.source === source &&
      entry.account === account &&
      Date.parse(entry.checkedAt) > Date.parse(startedAt),
  );
  let skippedResolutions = 0;
  // Proposals are transient. Counting them makes a run with no drafts
  // diagnosable: did the collector write none, or did a gate drop them?
  const counts: ProposalCounts = emptyCounts();
  // One result lists distinct requests on purpose. Second IDs appear across
  // runs, so only items saved before this result can absorb a new ID.
  const saved = [...state.items];
  for (const resolution of resolved) {
    const key = identity(source, account, resolution.sourceId);
    const current = state.items.find((item) => item.key === key);
    const expected = snapshot!.items.find((item) => item.key === key);
    // A reply can close only the exact context the collector reviewed. Local
    // edits, newer evidence and a newer collection take precedence.
    if (!current || newerCoverage || !isDeepStrictEqual(current, expected)) {
      skippedResolutions++;
      continue;
    }
    current.status = "resolved";
    current.resolution = resolution;
    current.decision = "answered";
    current.decidedAt = startedAt;
    delete current.snoozedUntil;
    current.draftRevision++;
    counts.closed.push(current.title);
  }
  // Same rule as a resolution: only an unchanged open request closes, and the
  // kept item must still exist. A newer message reopens the duplicate.
  for (const duplicate of duplicates) {
    const current = state.items.find((item) => item.key === duplicate.key);
    const expected = snapshot?.items.find((item) => item.key === duplicate.key);
    if (
      !current ||
      !snapshot ||
      newerCoverage ||
      current.source !== source ||
      current.account !== account ||
      !["open", "waiting"].includes(current.status) ||
      !isDeepStrictEqual(current, expected) ||
      !state.items.some((item) => item.key === duplicate.of)
    ) {
      skippedResolutions++;
      continue;
    }
    current.status = "dismissed";
    current.decision = "duplicate";
    current.decidedAt = startedAt;
    current.duplicateOf = duplicate.of;
    delete current.snoozedUntil;
    delete current.resolution;
    current.draftRevision++;
    counts.merged++;
  }
  for (const collected of candidates) {
    // A proposal is transient collector input, never a second saved reply.
    const { proposedReply, ...candidate } = collected;
    if (proposedReply) counts.proposals++;
    let key = identity(source, account, candidate.sourceId);
    if (!state.items.some((item) => item.key === key)) {
      const same = sameMessage(saved, source, account, candidate);
      if (same) {
        candidate.sourceId = same.sourceId;
        key = same.key;
        counts.merged++;
      }
    }
    const current = state.items.find((item) => item.key === key);
    const expected = snapshot?.items.find((item) => item.key === key);
    // Preserve concurrent local edits/status, but never discard newer provider
    // evidence or leave a concurrently edited reply looking fresh against it.
    if (snapshot && !isDeepStrictEqual(current, expected)) {
      if (
        current &&
        Date.parse(candidate.sourceUpdatedAt) >
          Date.parse(current.sourceUpdatedAt)
      ) {
        delete current.uncertainty;
        delete current.blocker;
        delete current.dueAt;
        Object.assign(current, candidate);
        delete current.resolution;
        current.draftStale = current.draftStale || Boolean(current.draft);
        current.draftRevision++;
      }
      continue;
    }
    const draft =
      (source === "mail" || source === "teams") &&
      account !== "unverified" &&
      !candidate.blocker &&
      !newerCoverage
        ? proposedReply || ""
        : "";
    if (!current) {
      state.items.push({
        ...candidate,
        key,
        source,
        account,
        status: "open",
        draft,
        draftRevision: draft ? 1 : 0,
        draftStale: false,
        ...(draft ? { draftOrigin: "triage" as const } : {}),
        firstSeenAt: startedAt,
      });
      if (draft) counts.seeded++;
      continue;
    }
    const delta =
      Date.parse(candidate.sourceUpdatedAt) -
      Date.parse(current.sourceUpdatedAt);
    if (delta < 0) continue;
    // Revision zero is deliberately conservative: a saved empty draft may
    // have been cleared by the user. Existing items also require a snapshot.
    const seedDraft =
      draft &&
      snapshot &&
      current.status === "open" &&
      !current.snoozedUntil &&
      !current.reminderAdded &&
      current.draft === "" &&
      current.draftRevision === 0 &&
      !current.draftStale;
    // A refreshed assessment replaces prior notes, including clearing them.
    delete current.uncertainty;
    delete current.blocker;
    delete current.dueAt;
    Object.assign(current, candidate);
    if (delta > 0) {
      // Newer activity starts a new open cycle on a closed item and ends any
      // deferral. firstSeenAt is history and stays.
      if (current.status === "resolved" || current.status === "dismissed")
        current.reopenedAt = candidate.sourceUpdatedAt;
      delete current.decision;
      delete current.decidedAt;
      delete current.resolution;
      delete current.duplicateOf;
      current.status = "open";
      delete current.snoozedUntil;
      current.draftStale = current.draftStale || Boolean(current.draft);
      // Invalidate an editor or AI draft opened against the old source context.
      current.draftRevision++;
    }
    if (seedDraft) {
      current.draft = draft;
      current.draftOrigin = "triage";
      current.draftRevision++;
      counts.seeded++;
    }
  }
  const previous = state.coverage.find(
    (entry) => entry.source === source && entry.account === account,
  );
  // A slower, older run may merge items, but cannot overwrite newer coverage.
  if (previous && Date.parse(previous.checkedAt) > Date.parse(startedAt))
    return counts;
  if (account !== "unverified" && status === "complete")
    state.coverage = state.coverage.filter(
      (entry) =>
        entry.source !== source ||
        entry.account !== "unverified" ||
        Date.parse(entry.checkedAt) > Date.parse(startedAt),
    );
  const coverage: Coverage = {
    source,
    account,
    status,
    detail: clean(
      [
        source === "mail" || source === "teams"
          ? `Drafts: ${counts.seeded} of ${counts.proposals} proposals seeded.`
          : "",
        closedSummary(counts),
        skippedResolutions
          ? `Skipped ${skippedResolutions} stale resolution(s) or duplicate mark(s): queue changed since collection started.`
          : "",
        extra.ignored
          ? `Ignored ${extra.ignored} unknown ref(s) or edited ID(s).`
          : "",
        detail,
      ]
        .filter(Boolean)
        .join(" "),
      500,
    ),
    checkedAt: startedAt,
    ...(previous?.cursor ? { cursor: previous.cursor } : {}),
  };
  if (status === "complete") coverage.cursor = startedAt;
  if (previous) Object.assign(previous, coverage);
  else state.coverage.push(coverage);
  return counts;
}
// The same provider message under a second ID: a moved mail or a retyped ID.
// Calendar and Notion times are too coarse to identify one message.
function sameMessage(
  saved: Item[],
  source: Source,
  account: string,
  candidate: Candidate,
): Item | undefined {
  const person = candidate.person.trim().toLowerCase();
  if ((source !== "mail" && source !== "teams") || !person) return;
  const matches = saved.filter(
    (item) =>
      item.source === source &&
      item.account === account &&
      item.sourceUpdatedAt === candidate.sourceUpdatedAt &&
      item.person.trim().toLowerCase() === person,
  );
  return (
    matches.find((item) => ["open", "waiting"].includes(item.status)) ??
    matches[0]
  );
}
export type ProposalCounts = {
  proposals: number;
  seeded: number;
  // Second IDs folded into a saved item, and duplicates the collector marked.
  merged: number;
  // Titles of requests that someone else's reply closed in this run.
  closed: string[];
};
export const emptyCounts = (): ProposalCounts => ({
  proposals: 0,
  seeded: 0,
  merged: 0,
  closed: [],
});
// One line for the finish notice and source coverage. Wins stay visible.
export function closedSummary(counts: ProposalCounts): string {
  const shown = counts.closed
    .slice(0, 3)
    .map((title) => truncate(title, 60))
    .join("; ");
  const more =
    counts.closed.length > 3 ? ` and ${counts.closed.length - 3} more` : "";
  return [
    counts.closed.length
      ? `Closed by others: ${counts.closed.length} (${shown}${more}).`
      : "",
    counts.merged ? `Merged ${counts.merged} duplicate(s).` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
function truncate(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
export function setDraft(
  state: State,
  key: string,
  expectedRevision: number,
  draft: string,
  origin: Exclude<DraftOrigin, "triage"> = "manual",
): void {
  const item = state.items.find((item) => item.key === key);
  if (!item || item.draftRevision !== expectedRevision)
    throw new Error(
      "This item changed in another view. Reopen it before editing.",
    );
  if (item.source === "remarkable")
    throw new Error("Scratchpad reviews do not support reply drafting.");
  if (draft.length > 20000)
    throw new Error("Draft is too long (maximum 20,000 characters).");
  item.draft = clean(draft, 20000);
  if (item.draft) item.draftOrigin = origin;
  else delete item.draftOrigin;
  item.draftRevision++;
  item.draftStale = false;
}
// Top shows the first few of Needs you. Deciding one reveals the next. Closed
// items have no view: new activity reopens them and deferrals return by date.
export const views = ["Top", "Needs you"] as const;
export function visibleItems(
  state: State,
  query = "",
  now = Date.now(),
): Item[] {
  return state.items
    .filter(
      (item) =>
        eligible(item, now) &&
        `${item.title}\n${item.person}\n${item.summary}\n${item.uncertainty || ""}\n${item.blocker || ""}\n${item.source}\n${item.account}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        rank(a, now) - rank(b, now) ||
        // Inside rank 1 the nearest deadline leads. Far dates never jump ahead.
        (rank(a, now) === 1 ? due(a) - due(b) : 0) ||
        activeSince(a) - activeSince(b) ||
        a.key.localeCompare(b.key),
    );
}
// A deadline inside this window counts as priority 1. An item ranked normal
// days ago rises as its date nears, without waiting for a refresh.
export const dueSoonMs = 48 * 3600000;
export function rank(item: Item, now = Date.now()): number {
  return item.dueAt && Date.parse(item.dueAt) - now <= dueSoonMs
    ? 1
    : item.priority;
}
// Undated items sort after dated ones within the same rank.
function due(item: Item): number {
  return item.dueAt ? Date.parse(item.dueAt) : Number.MAX_SAFE_INTEGER;
}
// Start of the current open cycle. sourceUpdatedAt is only a legacy proxy.
export function activeSince(item: Item): number {
  return Date.parse(
    item.reopenedAt ?? item.firstSeenAt ?? item.sourceUpdatedAt,
  );
}
// A waiting item returns when its follow-up date passes, so nothing deferred
// stays hidden without a way back.
export function eligible(item: Item, now = Date.now()): boolean {
  return (
    (item.status === "open" || item.status === "waiting") &&
    !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now)
  );
}
export const needsYouCap = 5;
// A waiting item asks again after this many days.
export const waitingDays = 3;
export function oldestDays(items: Item[], now = Date.now()): number {
  return items.length
    ? Math.max(
        0,
        Math.floor((now - Math.min(...items.map(activeSince))) / 86400000),
      )
    : 0;
}
// One local disposition. Status and decision always change together. Snooze
// and waiting hide the item until a date.
export function decide(
  item: Item,
  action: "next" | "drop" | "resolve" | "waiting" | "snooze",
  now = new Date(),
  until?: string,
): void {
  // Status round trips must still invalidate an in-flight assessment.
  item.draftRevision++;
  delete item.resolution;
  delete item.snoozedUntil;
  item.status =
    action === "drop"
      ? "dismissed"
      : action === "waiting"
        ? "waiting"
        : action === "snooze"
          ? "open"
          : "resolved";
  if (action === "snooze" || action === "waiting") {
    if (!until) throw new Error(`A ${action} decision needs its end time.`);
    item.snoozedUntil = until;
  }
  item.decision = action;
  item.decidedAt = now.toISOString();
}
export type Disposition = Pick<
  Item,
  | "status"
  | "decision"
  | "decidedAt"
  | "snoozedUntil"
  | "resolution"
  | "reopenedAt"
>;
// Every field a decision changes, always with the same keys.
export function disposition(item: Item): Disposition {
  const { status, decision, decidedAt, snoozedUntil, resolution, reopenedAt } =
    item;
  return structuredClone({
    status,
    decision,
    decidedAt,
    snoozedUntil,
    resolution,
    reopenedAt,
  });
}
export type Undo = {
  key: string;
  before: Disposition;
  after: Disposition;
  revision: number;
};
// Restores the disposition before a decision, only while nothing else changed
// the item since. A refresh or another session wins over a stale undo.
export function undo(item: Item, entry: Undo): boolean {
  if (
    item.draftRevision !== entry.revision ||
    !isDeepStrictEqual(disposition(item), entry.after)
  )
    return false;
  delete item.decision;
  delete item.decidedAt;
  delete item.snoozedUntil;
  delete item.resolution;
  delete item.reopenedAt;
  Object.assign(
    item,
    Object.fromEntries(
      Object.entries(structuredClone(entry.before)).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  );
  item.draftRevision++;
  return true;
}
export function demoState(now = new Date().toISOString()): State {
  const state = emptyState();
  ingest(
    state,
    "teams",
    "demo@example.invalid",
    [
      {
        sourceId: "demo-chat-1",
        sourceUpdatedAt: now,
        title: "Review the rollout plan",
        person: "Example colleague",
        summary:
          "Can you review the rollout plan before tomorrow? The draft is ready and needs your decision on timing.",
        suggestion: "Review the plan and reply with a go/no-go.",
        priority: 1,
      },
      {
        sourceId: "demo-chat-2",
        sourceUpdatedAt: now,
        title: "Confirm a meeting time",
        person: "Example project group",
        summary: "The team suggested Tuesday at 10:00.",
        uncertainty: "Calendar availability has not been checked.",
        suggestion: "Check availability, then draft a reply.",
        priority: 2,
      },
    ],
    "complete",
    "Demo data only",
    now,
  );
  ingest(
    state,
    "mail",
    "demo@example.invalid",
    [
      {
        sourceId: "demo-mail-1",
        sourceUpdatedAt: now,
        title: "Reply to the project update",
        person: "Example sender",
        summary:
          "The project update asks which of the two proposals to pursue.",
        suggestion: "Clarify the trade-off before committing.",
        priority: 2,
      },
    ],
    "complete",
    "Demo data only",
    now,
  );
  state.items[0].draft =
    "Thanks. I will review the rollout plan this afternoon and reply with the timing.";
  return state;
}
