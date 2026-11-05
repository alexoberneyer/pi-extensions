import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { packagePath, readConfig } from "../../lib/config.mjs";
import { initializeApproval } from "../approval/ready.ts";
import {
  copyToClipboard,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  Dashboard,
  type ActionRequest,
  type ActionResult,
  type Choice,
  type NextTask,
  type ViewState,
} from "./dashboard.ts";
import {
  clean,
  demoState,
  errorMessage,
  ingest,
  setDraft,
  collectionSources,
  validateCandidates,
  type Resolution,
  type Candidate,
  type Coverage,
  type Item,
  type State,
} from "./state.ts";
import { Store } from "./store.ts";
import { claimTriage, runClaudeTriage } from "./claude-triage.ts";
import {
  candidateSchema,
  resolutionSchema,
  mergeTriage,
} from "./triage-protocol.ts";
import { openSourceLink } from "./source-link.ts";
import {
  canonical,
  draftPrompt,
  meetingInstructions,
  meetingRequest,
  messageRequest,
  notesRequest,
  notesDirectory,
  refreshPrompt,
  reminderArguments,
  snoozeUntil,
} from "./workflow.ts";

import {
  captureActions,
  claimCaptureRoute,
  captureArguments,
  captureBase,
  captureBatchSize,
  captureItem,
  capturePrompt,
  changedPages,
  mergeCapture,
  parseManifest,
  reviewCapture,
  routeCapture,
  transcriptionSchema,
  type Manifest,
  type Page,
} from "./remarkable.ts";

const runFile = promisify(execFile);
const commandHelp = `Comms commands:
/comms: open the saved queue
/comms refresh: collect through Claude
/comms refresh pi: collect in this Pi conversation
/comms capture remarkable: capture scratchpad for review
/comms cancel: stop this session's Claude collector
/comms next: read the configured Reminders list
/comms status: show coverage and failures
/comms demo: open disposable demo data
/comms help: show this help`;
type Job =
  | {
      kind: "refresh";
      id: string;
      startedAt: string;
      state: State;
      completed: Set<string>;
    }
  | { kind: "draft"; key: string; revision: number }
  | {
      kind: "capture";
      id: string;
      startedAt: string;
      base: string;
      manifest?: Manifest;
      pages: Page[];
      saved: boolean;
      revoked?: boolean;
    };
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export default async function comms(pi: ExtensionAPI) {
  await initializeApproval(pi);
  const toolNames = [
    "comms_snapshot",
    "comms_ingest",
    "comms_save_draft",
    "comms_save_capture",
  ];
  const authorized = new Set<string>();
  function activateTools(...names: string[]): void {
    for (const name of names) authorized.add(name);
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  }
  function deactivateTools(names = toolNames): void {
    for (const name of names) authorized.delete(name);
    pi.setActiveTools(
      pi.getActiveTools().filter((name) => !names.includes(name)),
    );
  }
  let job: Job | undefined;
  let external:
    | { controller: AbortController; status: string; finished: Promise<void> }
    | undefined;
  let triageStatus = "";
  let refreshDashboard: (() => void) | undefined;
  let browsing = false;
  let active = true;
  let closeView: (() => void) | undefined;
  let subprocess: AbortController | undefined;
  let planning = false;
  let next: NextTask[] = [];
  let nextList: string | undefined;
  let nextLoaded = false;
  let savedView: ViewState = { view: 0, search: "" };
  const nextNotLoaded = "Not loaded. Ctrl+R reads Reminders on this Mac.";
  let nextStatus = nextNotLoaded;
  const store = () => new Store(join(getAgentDir(), "comms"));

  pi.events.on("dotfiles:plan-mode", (value) => {
    planning = value === true;
    if (planning && job?.kind === "capture") {
      job.revoked = true;
      subprocess?.abort();
    }
  });
  pi.on("session_start", () => {
    active = true;
    deactivateTools();
  });
  pi.on("session_shutdown", async () => {
    active = false;
    deactivateTools();
    job = undefined;
    closeView?.();
    subprocess?.abort();
    external?.controller.abort();
    await external?.finished;
  });
  pi.on("agent_settled", () => {
    job = undefined;
    deactivateTools(toolNames.filter((name) => name !== "comms_snapshot"));
  });

  // The triage/drafting pass cannot perform external writes, including nested
  // codemode calls. This guard is a workflow boundary, not an OS sandbox.
  pi.on("tool_call", (event) => {
    if (
      toolNames.includes(event.toolName) &&
      (!active || !authorized.has(event.toolName))
    )
      return {
        block: true,
        reason:
          "Activate the required tool through a user /comms action first.",
      };
    if (!job) return;
    if (job.kind === "capture") {
      if (event.toolName === "comms_save_capture") return;
      if (
        event.toolName === "read" &&
        job.pages.some((page) => page.image === event.input?.path)
      )
        return;
      return {
        block: true,
        reason:
          "Scratchpad capture only reads its selected page images and saves local review evidence. Other tools are blocked.",
      };
    }
    if (
      job.kind === "refresh" &&
      /(?:^|__)notion[-_]fetch$/.test(event.toolName) &&
      event.input.include_transcript !== undefined &&
      event.input.include_transcript !== false
    )
      return {
        block: true,
        reason: "Comms refresh reads summaries, never raw transcripts.",
      };
    if (
      [
        "comms_snapshot",
        "comms_ingest",
        "comms_save_draft",
        "read",
        "grep",
        "find",
        "ls",
        "tool_search",
        "codemode",
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
      ].includes(event.toolName)
    )
      return;
    const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
    if (
      event.toolName.startsWith("mcp__") &&
      tool?.annotations?.readOnlyHint === true &&
      tool.annotations.destructiveHint !== true
    )
      return;
    return {
      block: true,
      reason:
        "Comms collection/drafting is read-only. Unclassified tools and external writes are blocked. Finish this pass, then use the reviewed /message handoff.",
    };
  });

  pi.registerTool({
    name: "comms_snapshot",
    defaultActive: false,
    label: "Read Comms queue",
    description:
      "Read retained communication requests and source coverage. This is not the agent implementation todo list.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    async execute() {
      if (
        !active ||
        !authorized.has("comms_snapshot") ||
        job?.kind === "capture"
      )
        throw new Error(
          "Open /comms or start /comms refresh pi before reading the queue.",
        );
      const state = store().read();
      return result(
        job?.kind === "refresh"
          ? {
              ...state,
              items: state.items.filter((item) => item.source !== "remarkable"),
              coverage: state.coverage.filter(
                (entry) => entry.source !== "remarkable",
              ),
            }
          : state,
      );
    },
  });
  pi.registerTool({
    name: "comms_ingest",
    defaultActive: false,
    label: "Save triage results",
    description:
      "Persist one source/account result from the active user-requested /comms refresh. Retains unreported items and edited drafts. Explicit evidence-backed resolutions close only unchanged retained requests. Complete advances only this source/account cursor to the run start.",
    parameters: Type.Object({
      runId: Type.String(),
      source: StringEnum(collectionSources),
      account: Type.String({ minLength: 1, maxLength: 300 }),
      status: StringEnum(["complete", "partial", "unavailable"] as const),
      detail: Type.String({ maxLength: 500 }),
      items: Type.Array(candidateSchema, { maxItems: 1000 }),
      resolutions: Type.Optional(
        Type.Array(resolutionSchema, { maxItems: 1000 }),
      ),
    }),
    async execute(_id, args) {
      if (
        !active ||
        !authorized.has("comms_ingest") ||
        planning ||
        job?.kind !== "refresh" ||
        args.runId !== job.id
      )
        throw new Error(
          "Start a fresh /comms refresh pi before submitting Pi-native results.",
        );
      if (!collectionSources.includes(args.source))
        throw new Error(
          "Communication refresh cannot ingest local capture sources.",
        );
      const key = JSON.stringify([args.source, args.account]);
      if (job.completed.has(key))
        throw new Error(
          "This source/account was already committed for this run.",
        );
      const current = job;
      const items = validateCandidates(args.items as Candidate[], args.source);
      const state = store().update((state) =>
        ingest(
          state,
          args.source,
          args.account,
          items,
          args.status as Coverage["status"],
          args.detail,
          current.startedAt,
          args.resolutions as Resolution[] | undefined,
          current.state,
        ),
      );
      job.completed.add(key);
      return result({
        saved: items.length,
        retained: state.items.length,
        source: args.source,
        status: args.status,
      });
    },
  });
  pi.registerTool({
    name: "comms_save_draft",
    defaultActive: false,
    label: "Save local reply",
    description:
      "Save a local plain-text suggestion for the item selected by the user in /comms. Does not create an Outlook draft or send a message.",
    parameters: Type.Object({
      key: Type.String(),
      expectedRevision: Type.Integer(),
      draft: Type.String({ maxLength: 20000 }),
    }),
    async execute(_id, args) {
      if (
        !active ||
        !authorized.has("comms_save_draft") ||
        planning ||
        job?.kind !== "draft" ||
        job.key !== args.key ||
        job.revision !== args.expectedRevision
      )
        throw new Error("Select Draft with AI in /comms first.");
      store().update((state) =>
        setDraft(state, args.key, args.expectedRevision, args.draft),
      );
      return result({ saved: true, sent: false });
    },
  });

  pi.registerTool({
    name: "comms_save_capture",
    defaultActive: false,
    label: "Save scratchpad review",
    description:
      "Save up to five page transcriptions from the active, explicitly requested /comms capture remarkable. Creates local review evidence only, never reminders or replies.",
    parameters: transcriptionSchema,
    async execute(_id, args, signal) {
      const current = job;
      if (
        planning ||
        !active ||
        !authorized.has("comms_save_capture") ||
        current?.kind !== "capture" ||
        current.revoked ||
        current.id !== args.runId ||
        !current.manifest
      )
        throw new Error(
          "Start /comms capture remarkable before saving page transcriptions.",
        );
      signal?.throwIfAborted();
      if (current.saved) throw new Error("This capture was already saved.");
      const state = store().update((state) =>
        mergeCapture(
          state,
          current.manifest!,
          current.pages,
          args.pages,
          current.base,
          current.startedAt,
        ),
      );
      current.saved = true;
      const item = captureItem(state)!;
      return result({
        saved: true,
        pages: args.pages.length,
        pending: item.remarkable!.pending,
        next: "Open /comms to review. No reminders were added.",
      });
    },
  });

  function runningJob(): string | undefined {
    if (external)
      return `${external.status}\nClaude triage is already running. Use /comms cancel to stop it.`;
    if (job)
      return `Comms ${job.kind === "draft" ? "drafting" : job.kind === "capture" ? "scratchpad capture" : "Pi-native triage"} is already running in Pi. Press Escape in Pi to stop it. /comms cancel only stops Claude triage.`;
    return undefined;
  }
  function canStart(ctx: ExtensionCommandContext): void {
    if (planning)
      throw new Error(
        "Leave /plan mode before refreshing, drafting or adding a task.",
      );
    const busy = runningJob();
    if (busy) throw new Error(busy);
    if (
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      ctx.ui.getEditorText().trim()
    )
      throw new Error(
        "Finish the current run and pending input first. Your prompt was left intact.",
      );
  }
  function startClaudeRefresh(
    ctx: ExtensionCommandContext,
  ): string | undefined {
    if (planning) throw new Error("Leave /plan mode before refreshing Comms.");
    const busy = runningJob();
    if (busy) return busy;
    const queue = store();
    const requestState = queue.read();
    const instructions = readFileSync(canonical("triage"), "utf8");
    const release = claimTriage(queue.directory);
    const controller = new AbortController();
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const current = {
      controller,
      status: "Claude triage starting · /comms cancel stops it",
      finished: Promise.resolve(),
    };
    external = current;
    const publish = (text: string) => {
      current.status = clean(text, 300);
      triageStatus = current.status;
      if (active) {
        ctx.ui.setStatus("comms-triage", triageStatus);
        refreshDashboard?.();
      }
    };
    publish(current.status);
    current.finished = (async () => {
      try {
        const results = await runClaudeTriage({
          cwd: notesDirectory(false) || packagePath(),
          runId,
          startedAt,
          state: requestState,
          instructions,
          meetings: meetingInstructions(),
          signal: controller.signal,
          progress: publish,
        });
        controller.signal.throwIfAborted();
        if (!active) return;
        // Re-read under the existing atomic store lock. Local drafts/status edits
        // made while Claude collected evidence are never replaced by a snapshot.
        const latest = queue.update((state) =>
          mergeTriage(state, results, startedAt, requestState),
        );
        const incomplete = results.filter(
          (row) => row.status !== "complete",
        ).length;
        publish(
          `Claude triage finished · ${latest.items.length} retained · ${incomplete} incomplete source/account checks`,
        );
        ctx.ui.notify(
          incomplete
            ? `Claude triage finished with ${incomplete} incomplete source/account checks. Open /comms status for details. No replies were sent.`
            : "Claude triage finished. Open /comms to review. No replies were sent.",
          incomplete ? "warning" : "info",
        );
      } catch (error) {
        publish(errorMessage(error, 1000));
        if (active) ctx.ui.notify(triageStatus, "warning");
      } finally {
        try {
          release();
        } catch {
          publish(
            "Claude triage ended, but its lock could not be removed. Inspect the private triage.lock before retrying.",
          );
        }
        if (external === current) external = undefined;
        if (active) refreshDashboard?.();
      }
    })();
  }
  function cancelClaudeRefresh(): string | undefined {
    if (!external)
      return runningJob() || "No Claude triage is running in this Pi session.";
    triageStatus = external.status =
      "Cancelling Claude triage. Waiting for its process to exit.";
    external.controller.abort();
    refreshDashboard?.();
  }
  function startRefresh(ctx: ExtensionCommandContext): void {
    canStart(ctx);
    const file = canonical("triage");
    const state = store().read();
    const current: Job = {
      kind: "refresh",
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      state,
      completed: new Set(),
    };
    job = current;
    try {
      activateTools("comms_snapshot", "comms_ingest");
      pi.sendUserMessage(
        refreshPrompt(
          current.id,
          current.startedAt,
          state,
          file,
          meetingInstructions(),
        ),
      );
    } catch (error) {
      job = undefined;
      throw error;
    }
  }
  function startDraft(ctx: ExtensionCommandContext, item: Item): void {
    canStart(ctx);
    const file = canonical("message");
    job = { kind: "draft", key: item.key, revision: item.draftRevision };
    try {
      activateTools("comms_snapshot", "comms_save_draft");
      pi.sendUserMessage(draftPrompt(item, file));
    } catch (error) {
      job = undefined;
      throw error;
    }
  }
  async function startCapture(ctx: ExtensionCommandContext): Promise<void> {
    canStart(ctx);
    if (process.platform !== "darwin")
      throw new Error(
        "Scratchpad capture requires this Mac's reMarkable desktop copy.",
      );
    const queue = store();
    const previous = captureItem(queue.read());
    const script = packagePath("helpers", "remarkable.py");
    if (!existsSync(script))
      throw new Error(`Missing reMarkable reader: ${script}`);
    const current: Extract<Job, { kind: "capture" }> = {
      kind: "capture",
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      base: captureBase(previous),
      pages: [],
      saved: false,
    };
    job = current;
    const controller = new AbortController();
    subprocess = controller;
    try {
      const output = join(queue.directory, "remarkable-pages");
      ctx.ui.notify(
        "Reading scratchpad from the reMarkable desktop copy…",
        "info",
      );
      const { stdout } = await runFile(
        "uv",
        captureArguments(output, previous?.sourceId),
        {
          cwd: packagePath(),
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          signal: controller.signal,
        },
      );
      controller.signal.throwIfAborted();
      if (!active || planning || current.revoked || job !== current)
        throw new Error("Scratchpad capture stopped before transcription.");
      const manifest = parseManifest(JSON.parse(stdout), output);
      if (previous && manifest.notebookId !== previous.sourceId)
        throw new Error(
          "The reader returned a different notebook than the pinned scratchpad.",
        );
      current.manifest = manifest;
      current.pages = changedPages(manifest, previous).slice(
        0,
        captureBatchSize,
      );
      ctx.ui.notify(
        `Desktop copy newest change: ${manifest.newestChangeAt}. Tablet sync is unverified.`,
        "info",
      );
      if (!current.pages.length) {
        queue.update((state) =>
          mergeCapture(
            state,
            manifest,
            [],
            [],
            current.base,
            current.startedAt,
          ),
        );
        job = undefined;
        ctx.ui.notify(
          "No page transcriptions changed. Scratchpad status and routed actions were preserved. Open /comms to review.",
          "info",
        );
        return;
      }
      if (
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        ctx.ui.getEditorText().trim()
      )
        throw new Error(
          "Pending input appeared during capture. Your prompt was left intact. Run capture again when idle.",
        );
      if (
        current.pages.some((page) => page.image) &&
        !ctx.model?.input.includes("image")
      )
        throw new Error(
          "Select an image-capable model before transcribing scratchpad handwriting.",
        );
      activateTools("comms_save_capture");
      pi.sendUserMessage(
        capturePrompt(current.id, manifest, current.pages, previous),
      );
    } catch (error) {
      if (job === current) job = undefined;
      const reason = error as Error & { stderr?: string };
      throw new Error(clean(reason.stderr || reason.message, 1200));
    } finally {
      if (subprocess === controller) subprocess = undefined;
    }
  }
  async function reminders(
    titles: string[] = [],
    list = readConfig().comms.reminderList,
  ): Promise<unknown> {
    if (process.platform !== "darwin")
      throw new Error(
        "Reminders requires your Mac. No remote fallback is configured.",
      );
    const script = packagePath("helpers", "to_next.py");
    if (!existsSync(script))
      throw new Error(`Missing Reminders helper: ${script}`);
    const controller = new AbortController();
    subprocess = controller;
    try {
      const { stdout } = await runFile("uv", reminderArguments(titles, list), {
        cwd: packagePath(),
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        signal: controller.signal,
      });
      return JSON.parse(stdout);
    } catch (error) {
      const reason = error as Error & { stderr?: string };
      throw new Error(clean(reason.stderr || reason.message, 1000));
    } finally {
      if (subprocess === controller) subprocess = undefined;
    }
  }
  async function refreshNext(config = readConfig()): Promise<void> {
    const list = config.comms.reminderList;
    const timeZone = config.identity.timeZone;
    if (nextList !== list) {
      next = [];
      nextLoaded = false;
      nextList = list;
    }
    try {
      const rows = await reminders([], list);
      if (
        !Array.isArray(rows) ||
        rows.some(
          (row) =>
            typeof row?.title !== "string" ||
            (row.due !== null && typeof row.due !== "string"),
        )
      )
        throw new Error("Unexpected Reminders response.");
      next = rows.map((row) => ({
        title: clean(row.title, 500),
        due: row.due,
      }));
      nextLoaded = true;
      nextStatus = `Read ${new Date().toLocaleString("en", { timeZone })} · Reminders ${list}`;
    } catch (error) {
      nextStatus = `Unavailable: ${errorMessage(error, 250)}. Cached tasks may be stale.`;
      throw error;
    }
  }
  async function browse(
    ctx: ExtensionCommandContext,
    demo: boolean,
    initialView = 0,
  ): Promise<void> {
    const config = demo ? undefined : readConfig();
    const list = config?.comms.reminderList ?? "Next";
    if (!demo && initialView === 2) {
      ctx.ui.notify(`Reading Reminders ${list}…`, "info");
      await refreshNext(config);
    }
    let memory = demoState();
    let view: ViewState =
      demo || initialView === 2 ? { view: initialView, search: "" } : savedView;
    let notice = "";
    const read = () => (demo ? structuredClone(memory) : store().read());
    const update = (change: (state: State) => void) => {
      if (demo) change(memory);
      else store().update(change);
    };
    const snapshot = (message = ""): ActionResult => ({
      state: read(),
      reminderList: list,
      next: demo
        ? [{ title: "Example task in Next", due: null }]
        : nextList === list
          ? next
          : [],
      nextStatus: demo
        ? "Demo tasks only"
        : nextList === list
          ? nextStatus
          : nextNotLoaded,
      nextLoaded: demo || (nextList === list && nextLoaded),
      triageStatus: demo ? undefined : triageStatus,
      triageRunning: !demo && Boolean(external),
      notice: message,
    });
    const currentItem = (item?: Item, state = read()): Item => {
      const current = state.items.find((row) => row.key === item?.key);
      if (
        !item ||
        !current ||
        current.sourceUpdatedAt !== item.sourceUpdatedAt ||
        current.draftRevision !== item.draftRevision
      )
        throw new Error(
          "This request changed. Reload the local queue before acting.",
        );
      return current;
    };
    const perform = async ({
      action,
      item,
      text,
      captureAction,
    }: ActionRequest): Promise<ActionResult> => {
      if (!active) throw new Error("This Comms view has closed.");
      if (action === "refresh" || action === "cancel-triage") {
        if (demo) throw new Error("Demo cannot start or cancel live triage.");
        return snapshot(
          (action === "refresh"
            ? startClaudeRefresh(ctx)
            : cancelClaudeRefresh()) || "",
        );
      }
      if (action === "reload")
        return snapshot("Local queue reloaded. No model or provider calls.");
      if (action === "reset-demo") {
        if (!demo) throw new Error("Only demo data can be reset.");
        memory = demoState();
        return snapshot("Demo reset. No external actions.");
      }
      if (action === "next") {
        if (!demo) {
          try {
            await refreshNext(config);
          } catch (error) {
            return snapshot(errorMessage(error));
          }
        }
        return snapshot();
      }
      const current = currentItem(item);
      if (action === "copy") {
        if (!current.draft) throw new Error("No draft yet.");
        await copyToClipboard(current.draft);
        return snapshot("Draft copied. Nothing sent.");
      }
      if (
        demo &&
        (action === "open-original" ||
          action === "open-browser" ||
          action === "add-next")
      )
        throw new Error(
          "Demo mode cannot open live sources or write to Reminders.",
        );
      if (action === "open-original" || action === "open-browser") {
        if (!current.url) throw new Error("No source link available.");
        if (process.platform !== "darwin")
          throw new Error(
            "Open original requires your Mac. The URL is in request details.",
          );
        return snapshot(
          await openSourceLink(
            current.source,
            current.url,
            (args) => runFile("open", args, { timeout: 10000 }),
            action === "open-browser",
          ),
        );
      }
      if (planning)
        throw new Error("Leave /plan mode before changing Comms items.");
      if (action === "save-draft") {
        if (text === undefined) throw new Error("Missing draft text.");
        update((state) =>
          setDraft(state, current.key, current.draftRevision, text),
        );
        return snapshot("Local draft saved. Nothing sent.");
      }
      if (action === "add-next") {
        canStart(ctx);
        const normalized = clean(text || "", 2000)
          .replace(/\s+/g, " ")
          .trim();
        if (!normalized) throw new Error(`Enter one action for ${list}.`);
        let releaseRoute: (() => void) | undefined;
        let uncertainRoute = false;
        const recovery = `Check ${list} and inspect ${join(store().directory, "remarkable-next.lock")} before retrying.`;
        try {
          if (current.source === "remarkable") {
            releaseRoute = claimCaptureRoute(store().directory, {
              notebookId: current.sourceId,
              action: captureAction,
              title: normalized,
            });
            // Re-read after taking the shared routing lock. Another Pi session
            // may have routed this excerpt while this editor was open.
            const latest = currentItem(current);
            if (
              !captureAction ||
              !captureActions(latest).some(
                (action) =>
                  action.pageId === captureAction.pageId &&
                  action.excerpt === captureAction.excerpt,
              )
            )
              throw new Error(
                `Select an unrouted scratchpad action before adding it to ${list}.`,
              );
          }
          uncertainRoute = Boolean(releaseRoute);
          const outcome = (await reminders([normalized], list)) as {
            mode?: string;
            added?: string[];
            skipped?: string[];
          };
          if (
            outcome.mode !== "apply" ||
            ![...(outcome.added || []), ...(outcome.skipped || [])].includes(
              normalized,
            )
          )
            throw new Error(
              `Reminders returned an unrecognized result. Check ${list} before retrying.`,
            );
          if (nextList !== list) {
            next = [];
            nextLoaded = false;
            nextList = list;
          }
          nextStatus = `A task was added. Ctrl+R refreshes ${list}.`;
          try {
            update((state) => {
              const row = state.items.find((row) => row.key === current.key);
              if (!row)
                throw new Error(
                  "The source item disappeared before routing was recorded.",
                );
              row.reminderAdded = normalized;
              if (row.source === "remarkable" && captureAction)
                routeCapture(row, captureAction, normalized);
            });
          } catch {
            return snapshot(
              `Action is in ${list}, but its local marker could not be saved. Do not add it again.${releaseRoute ? ` ${recovery}` : ""}`,
            );
          }
          uncertainRoute = false;
          return snapshot(
            `Action is in Reminders ${list}. The review remains open.`,
          );
        } catch (error) {
          if (uncertainRoute)
            throw new Error(`${errorMessage(error)} ${recovery}`);
          throw error;
        } finally {
          // If the remote outcome or queue write is uncertain, retain the lock
          // rather than permit another edited title to create a duplicate.
          if (!uncertainRoute) releaseRoute?.();
        }
      }
      update((state) => {
        const row = currentItem(current, state);
        // Status round trips must still invalidate an in-flight assessment.
        row.draftRevision++;
        delete row.resolution;
        if (
          row.source === "remarkable" &&
          (action === "resolve" || action === "dismiss")
        )
          reviewCapture(row);
        if (action === "snooze") {
          row.snoozedUntil = snoozeUntil();
          row.status = "open";
        } else {
          row.status =
            action === "waiting"
              ? "waiting"
              : action === "resolve"
                ? "resolved"
                : action === "dismiss"
                  ? "dismissed"
                  : "open";
          delete row.snoozedUntil;
        }
      });
      return snapshot(
        "Local status updated. Nothing sent or deleted at the source.",
      );
    };
    while (active) {
      let dashboard: Dashboard | undefined;
      let choice: Choice | undefined;
      try {
        choice = await ctx.ui.custom<Choice | undefined>(
          (tui, theme, keys, done) => {
            closeView = () => done(undefined);
            dashboard = new Dashboard(
              tui,
              theme,
              keys,
              snapshot(),
              done,
              perform,
              demo,
              view,
              (listener) => ctx.ui.onTerminalInput(listener),
            );
            dashboard.setNotice(notice);
            if (!demo)
              refreshDashboard = () => {
                try {
                  dashboard?.setData(snapshot());
                } catch (error) {
                  dashboard?.setNotice(errorMessage(error, 1000));
                }
              };
            return dashboard;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              anchor: "top-left",
            },
          },
        );
      } finally {
        if (dashboard) {
          view = dashboard.viewState();
          if (!demo) savedView = view;
          dashboard.dispose();
        }
        closeView = undefined;
        refreshDashboard = undefined;
      }
      if (!choice || !active) return;
      view = choice.view;
      try {
        if (demo)
          throw new Error(
            "Demo mode cannot call a model or use the message workflow.",
          );
        if (choice.action === "refresh") startRefresh(ctx);
        else {
          const item = currentItem(choice.item);
          if (choice.action === "draft-ai") startDraft(ctx, item);
          else {
            canStart(ctx);
            if (choice.action === "integrate-notes") {
              const topic = await ctx.ui.input(
                "Which scratchpad topic or section?",
                "For example: Customer/Chat support process",
              );
              if (!active) return;
              if (topic === undefined) {
                notice = "Notes integration cancelled. Nothing changed.";
                continue;
              }
              // Re-check after the dialog. New input or another session's
              // capture must not be overwritten by an old handoff.
              canStart(ctx);
              const latest = currentItem(item);
              const request = notesRequest(latest, topic);
              activateTools("comms_snapshot");
              ctx.ui.setEditorText(request);
              ctx.ui.notify(
                "Notes integration placed in your prompt. Submit to review a structured brief and proposed file updates. Filing and reminders still require your confirmation.",
                "info",
              );
              return;
            }
            const meeting = choice.action === "integrate-meeting";
            ctx.ui.setEditorText(
              meeting
                ? meetingRequest(item, canonical("paste-meetings"))
                : messageRequest(item, canonical("message")),
            );
            ctx.ui.notify(
              meeting
                ? "Meeting integration placed in your prompt. Submit to review proposed notes and reminders. Filing still requires your confirmation."
                : "Reviewed reply placed in your prompt. Submit to run the existing message workflow. Mail stays draft-only; Teams asks before sending.",
              "info",
            );
          }
        }
        return;
      } catch (error) {
        notice = errorMessage(error);
      }
    }
  }
  pi.registerCommand("comms", {
    description:
      "Review communications: /comms [refresh [pi]|capture remarkable|cancel|next|status|demo|help]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/comms needs Pi's interactive terminal UI.", "warning");
        return;
      }
      const command = args.trim().replace(/\s+/g, " ");
      if (["help", "-h", "--help"].includes(command)) {
        ctx.ui.notify(commandHelp, "info");
        return;
      }
      if (
        ![
          "",
          "refresh",
          "refresh pi",
          "capture remarkable",
          "cancel",
          "next",
          "status",
          "demo",
        ].includes(command)
      ) {
        ctx.ui.notify(
          `Unknown Comms arguments: ${clean(command, 120)}\n${commandHelp}`,
          "warning",
        );
        return;
      }
      if (browsing && !["refresh", "cancel", "status"].includes(command))
        return;
      try {
        if (command === "refresh") {
          const notice = startClaudeRefresh(ctx);
          if (notice) ctx.ui.notify(notice, "info");
          return;
        }
        if (command === "capture remarkable") {
          await startCapture(ctx);
          return;
        }
        if (command === "refresh pi") {
          const busy = runningJob();
          if (busy) ctx.ui.notify(busy, "info");
          else startRefresh(ctx);
          return;
        }
        if (command === "cancel") {
          const notice = cancelClaudeRefresh();
          if (notice) ctx.ui.notify(notice, "info");
          return;
        }
        if (command === "status") {
          activateTools("comms_snapshot");
          const state = store().read();
          ctx.ui.notify(
            `Queue: ${state.items.length} retained items\n${store().file}\nNotes: ${notesDirectory(false) || "not configured"}\nTriage: ${runningJob() || triageStatus || "Claude triage has not run in this Pi session."}\n${state.coverage.map((source) => `${source.source} · ${source.account} · ${source.status} · ${source.checkedAt}\n${source.detail}`).join("\n") || "No sources checked. Run /comms refresh using Claude's existing connections."}\n${nextStatus}`,
            "info",
          );
          return;
        }
        if (command !== "demo") activateTools("comms_snapshot");
        browsing = true;
        try {
          if (active)
            await browse(ctx, command === "demo", command === "next" ? 2 : 0);
        } finally {
          browsing = false;
          closeView = undefined;
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}
