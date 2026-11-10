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
] as const;
export type Decision = (typeof decisions)[number];
export type Candidate = {
  sourceId: string;
  sourceUpdatedAt: string;
  title: string;
  person: string;
  summary: string;
  uncertainty?: string;
  suggestion: string;
  proposedReply?: string;
  priority: number;
  url?: string;
};
export type Resolution = {
  sourceId: string;
  sourceUpdatedAt: string;
  evidenceId: string;
  evidenceAt: string;
  reason: string;
};
export type Item = Omit<Candidate, "proposedReply"> & {
  key: string;
  source: Source;
  account: string;
  status: Status;
  snoozedUntil?: string;
  draft: string;
  draftRevision: number;
  draftStale: boolean;
  reminderAdded?: string;
  resolution?: Resolution;
  // Optional lifecycle fields. Legacy items stay undated rather than invented.
  firstSeenAt?: string;
  reopenedAt?: string;
  decision?: Decision;
  decidedAt?: string;
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
function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
export function validateCandidate(
  value: Candidate,
  source?: Source,
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
  if (
    value.uncertainty !== undefined &&
    (typeof value.uncertainty !== "string" || value.uncertainty.length > 2000)
  )
    throw new Error("Invalid item uncertainty.");
  if (
    value.proposedReply !== undefined &&
    (typeof value.proposedReply !== "string" ||
      value.proposedReply.length > 20000)
  )
    throw new Error("Invalid item proposedReply (maximum 20,000 characters).");
  if (![1, 2, 3].includes(value.priority))
    throw new Error("Priority must be 1, 2 or 3.");
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
      ? { uncertainty: clean(value.uncertainty, 2000).trim() }
      : {}),
    suggestion: clean(value.suggestion, 2000),
    ...(value.proposedReply !== undefined
      ? { proposedReply: clean(value.proposedReply, 20000).trim() }
      : {}),
    priority: value.priority,
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
    validateCandidate(item, item.source);
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
      (item.decision !== undefined && !decisions.includes(item.decision))
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
): void {
  if (
    !(collectionSources as readonly string[]).includes(source) ||
    !account.trim() ||
    account.length > 300 ||
    !validDate(startedAt) ||
    !["complete", "partial", "unavailable"].includes(status) ||
    items.length > 1000
  )
    throw new Error("Invalid collection result.");
  if (status === "unavailable" && (items.length || resolutions.length))
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
  }
  for (const collected of candidates) {
    // A proposal is transient collector input, never a second saved reply.
    const { proposedReply, ...candidate } = collected;
    const key = identity(source, account, candidate.sourceId);
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
      !candidate.uncertainty &&
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
        firstSeenAt: startedAt,
      });
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
    // A refreshed assessment replaces prior uncertainty, including clearing it.
    delete current.uncertainty;
    Object.assign(current, candidate);
    if (delta > 0) {
      // Newer activity starts a new open cycle on a closed item and ends any
      // deferral. firstSeenAt is history and stays.
      if (current.status === "resolved" || current.status === "dismissed")
        current.reopenedAt = candidate.sourceUpdatedAt;
      delete current.decision;
      delete current.decidedAt;
      delete current.resolution;
      current.status = "open";
      delete current.snoozedUntil;
      current.draftStale = current.draftStale || Boolean(current.draft);
      // Invalidate an editor or AI draft opened against the old source context.
      current.draftRevision++;
    }
    if (seedDraft) {
      current.draft = draft;
      current.draftRevision++;
    }
  }
  const previous = state.coverage.find(
    (entry) => entry.source === source && entry.account === account,
  );
  // A slower, older run may merge items, but cannot overwrite newer coverage.
  if (previous && Date.parse(previous.checkedAt) > Date.parse(startedAt))
    return;
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
      skippedResolutions
        ? `Skipped ${skippedResolutions} stale resolution(s): queue changed since collection started. ${detail}`
        : detail,
      500,
    ),
    checkedAt: startedAt,
    ...(previous?.cursor ? { cursor: previous.cursor } : {}),
  };
  if (status === "complete") coverage.cursor = startedAt;
  if (previous) Object.assign(previous, coverage);
  else state.coverage.push(coverage);
}
export function setDraft(
  state: State,
  key: string,
  expectedRevision: number,
  draft: string,
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
  item.draftRevision++;
  item.draftStale = false;
}
export const views = ["Needs you", "Drafts", "Next", "Waiting", "All"] as const;
export function visibleItems(
  state: State,
  view: string,
  query = "",
  now = Date.now(),
): Item[] {
  return state.items
    .filter((item) => {
      if (view === "Needs you" && !eligible(item, now)) return false;
      if (
        view === "Drafts" &&
        (!item.draft || ["resolved", "dismissed"].includes(item.status))
      )
        return false;
      if (view === "Waiting" && item.status !== "waiting") return false;
      if (view === "Next") return false;
      return `${item.title}\n${item.person}\n${item.summary}\n${item.uncertainty || ""}\n${item.source}\n${item.account}`
        .toLowerCase()
        .includes(query.toLowerCase());
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        activeSince(a) - activeSince(b) ||
        a.key.localeCompare(b.key),
    );
}
// Start of the current open cycle. sourceUpdatedAt is only a legacy proxy.
export function activeSince(item: Item): number {
  return Date.parse(
    item.reopenedAt ?? item.firstSeenAt ?? item.sourceUpdatedAt,
  );
}
export function eligible(item: Item, now = Date.now()): boolean {
  return (
    item.status === "open" &&
    !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now)
  );
}
export const needsYouCap = 5;
export function backlog(items: Item[], now = Date.now()) {
  const open = items.filter((item) => eligible(item, now));
  return {
    eligible: open.length,
    unresolved: items.filter((item) =>
      ["open", "waiting"].includes(item.status),
    ).length,
    oldestDays: open.length
      ? Math.max(
          0,
          Math.floor((now - Math.min(...open.map(activeSince))) / 86400000),
        )
      : 0,
  };
}
// One local disposition. Status and decision always change together.
export function decide(
  item: Item,
  action: "next" | "drop" | "resolve" | "waiting" | "snooze" | "reopen",
  now = new Date(),
  snoozedUntil?: string,
): void {
  // Status round trips must still invalidate an in-flight assessment.
  item.draftRevision++;
  delete item.resolution;
  delete item.snoozedUntil;
  if (action === "reopen") {
    if (item.status === "resolved" || item.status === "dismissed")
      item.reopenedAt = now.toISOString();
    item.status = "open";
    delete item.decision;
    delete item.decidedAt;
    return;
  }
  item.status =
    action === "drop"
      ? "dismissed"
      : action === "waiting"
        ? "waiting"
        : action === "snooze"
          ? "open"
          : "resolved";
  if (action === "snooze") {
    if (!snoozedUntil) throw new Error("A snooze needs its end time.");
    item.snoozedUntil = snoozedUntil;
  }
  item.decision = action;
  item.decidedAt = now.toISOString();
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
