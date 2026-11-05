import { statSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../lib/config.mjs";
import {
  getAgentDir,
  copyToClipboard,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Dashboard } from "./dashboard.ts";
import { attachAgent } from "./attach.ts";
import { closeTmuxPane } from "./close.ts";
import { createLocalTmuxAdapter, mergeLocalTmux } from "./local-tmux.ts";
import { tmuxPresence } from "./tmux-target.ts";
import { launchAgent } from "./launch.ts";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import { createDev01Adapter } from "./dev01.ts";
import { ExternalSessions } from "./external.ts";
import {
  HEARTBEAT_MS,
  Registry,
  mergeRows,
  pathKey,
  plain,
  textContent,
  type AgentRow,
  type LiveStatus,
  type SavedSession,
} from "./state.ts";

export default function agentsExtension(pi: ExtensionAPI) {
  let registry: Registry | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let browsing = false;
  let closeDashboard: (() => void) | undefined;
  let title = "New session";
  let preview = "";
  let updated = Date.now();
  let settled: LiveStatus = "ready";
  let running = false;
  let waiting: string | undefined;
  let trackingError = "";

  function restore(ctx: ExtensionContext): void {
    title = "New session";
    preview = "";
    settled = "ready";
    let firstUser = "";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = textContent(message);
      if (!firstUser && message.role === "user") firstUser = text;
      if (text) preview = text;
      if (Number.isFinite(message.timestamp)) updated = message.timestamp;
      if (message.role === "assistant") {
        settled =
          message.stopReason === "error"
            ? "error"
            : message.stopReason === "aborted"
              ? "stopped"
              : "ready";
      }
    }
    title = plain(
      ctx.sessionManager.getSessionName() || firstUser || "New session",
      160,
    );
  }

  function publish(ctx: ExtensionContext): void {
    if (!active || !registry) return;
    try {
      registry.write({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        title: plain(ctx.sessionManager.getSessionName() || title, 160),
        preview: waiting ? `Waiting for input: ${waiting}` : preview,
        model: plain(
          ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model",
          100,
        ),
        status:
          waiting !== undefined
            ? "waiting"
            : running || !ctx.isIdle()
              ? "working"
              : settled,
        updated,
        // Headless children inherit TMUX but do not own their parent's terminal.
        tmux: ctx.mode === "tui" ? tmuxPresence() : undefined,
      });
      trackingError = "";
    } catch (error) {
      const firstFailure = !trackingError;
      trackingError = `Agents status unavailable: ${plain(String(error), 300)}`;
      if (firstFailure) ctx.ui.notify(trackingError, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    registry = new Registry(join(getAgentDir(), "agents-status"));
    active = true;
    waiting = undefined;
    running = !ctx.isIdle();
    restore(ctx);
    publish(ctx);
    heartbeat = setInterval(() => publish(ctx), HEARTBEAT_MS);
    heartbeat.unref();
  });

  pi.on("session_shutdown", () => {
    active = false;
    if (heartbeat) clearInterval(heartbeat);
    closeDashboard?.();
    try {
      registry?.dispose();
    } catch {
      /* A stale record is ignored once its process exits. */
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    running = true;
    settled = "ready";
    updated = Date.now();
    publish(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "user" && message.role !== "assistant") return;
    const text = textContent(message);
    if (text) preview = text;
    if (message.role === "user" && title === "New session")
      title = plain(text, 160) || title;
    updated = Date.now();
    publish(ctx);
  });

  // agent_end is too early: retries, compaction and queued work may follow it.
  pi.on("agent_before_settle", (event) => {
    settled =
      event.outcome === "error"
        ? "error"
        : event.outcome === "aborted"
          ? "stopped"
          : "ready";
  });
  pi.on("agent_settled", (event, ctx) => {
    running = false;
    if (event.aborted) settled = "stopped";
    updated = Date.now();
    publish(ctx);
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    // The dashboard itself is navigation, not a task waiting for an answer.
    if (browsing && event.kind === "custom") return;
    waiting = plain(event.title || event.kind, 200);
    updated = Date.now();
    publish(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    waiting = undefined;
    publish(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => {
    restore(ctx);
    publish(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    publish(ctx);
  });
  pi.on("model_select", (_event, ctx) => publish(ctx));

  function otherOwners(file: string) {
    const key = pathKey(file);
    return registry!
      .list()
      .filter(
        (owner) =>
          owner.instance !== registry!.instance &&
          owner.sessionFile &&
          pathKey(owner.sessionFile) === key,
      );
  }

  // Protect native /resume as well as the dashboard from known live owners.
  pi.on("session_before_switch", (event, ctx) => {
    if (!registry || !event.targetSessionFile) return;
    try {
      if (!otherOwners(event.targetSessionFile).length) {
        if (statSync(event.targetSessionFile).isFile()) return;
        throw new Error(
          "The saved session is no longer a file. Refresh /agents.",
        );
      }
      ctx.ui.notify(
        "This session is open in another Pi process. Use its original terminal.",
        "warning",
      );
    } catch (error) {
      ctx.ui.notify(
        `Cannot reopen session: ${plain(String(error), 300)}`,
        "error",
      );
    }
    return { cancel: true };
  });

  pi.registerCommand("agents", {
    description: "Pi, Claude Code and Codex sessions, grouped by project",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agents needs Pi's interactive terminal UI.", "warning");
        return;
      }
      if (!registry || !active || browsing) return;
      publish(ctx);
      if (trackingError) {
        ctx.ui.notify(trackingError, "error");
        return;
      }
      const remoteEnabled =
        Boolean(readConfig().remote.host) &&
        process.env.PI_AGENTS_EXTERNAL !== "0" &&
        process.env.PI_AGENTS_DEV01 !== "0";
      const store = registry;
      let history: SavedSession[] = [];
      let historyAbort: AbortController | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let view: Dashboard | undefined;
      let loading = "Loading saved sessions…";
      let closed = false;
      const external = new ExternalSessions(
        process.env.PI_AGENTS_EXTERNAL === "0"
          ? []
          : [
              createClaudeAdapter(),
              createCodexAdapter(),
              createLocalTmuxAdapter(() => store.list()),
              ...(process.platform === "darwin" && remoteEnabled
                ? [createDev01Adapter()]
                : []),
            ],
        () => update(),
      );
      const cleanup = () => {
        if (closed) return;
        closed = true;
        view?.dispose();
        external.dispose();
        historyAbort?.abort();
        if (poll) clearInterval(poll);
      };
      const update = () => {
        if (closed) return;
        try {
          view?.setData(
            mergeLocalTmux([
              ...mergeRows(history, store.list(), store.instance),
              ...external.rows,
            ]),
            [loading, external.summary].filter(Boolean).join(" · "),
          );
        } catch (error) {
          view?.setNotice(
            `Cannot refresh status: ${plain(String(error), 300)}`,
          );
        }
      };
      const refresh = async () => {
        external.refresh();
        historyAbort?.abort();
        const controller = new AbortController();
        historyAbort = controller;
        loading = "Loading saved sessions…";
        update();
        try {
          // Include --session-dir for this session without replacing the global catalog.
          const lists = await Promise.all([
            SessionManager.listAll(undefined, controller.signal),
            SessionManager.list(
              ctx.cwd,
              ctx.sessionManager.getSessionDir(),
              undefined,
              controller.signal,
            ),
          ]);
          if (closed || controller.signal.aborted) return;
          history = [
            ...new Map(
              lists.flat().map((session) => [pathKey(session.path), session]),
            ).values(),
          ];
          loading = "";
          update();
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          loading = "History unavailable. Ctrl+R retries.";
          update();
          view?.setNotice(plain(String(error), 300));
        }
      };
      browsing = true;
      let selected: AgentRow | undefined;
      try {
        selected = await ctx.ui.custom<AgentRow | undefined>(
          (tui, theme, keys, done) => {
            closeDashboard = () => done(undefined);
            view = new Dashboard(
              tui,
              theme,
              keys,
              pathKey(ctx.cwd),
              done,
              () => {
                void refresh();
              },
              cleanup,
              copyToClipboard,
              process.platform === "darwin" ? launchAgent : undefined,
              remoteEnabled,
              (target, signal) => attachAgent(tui, target, signal),
              closeTmuxPane,
            );
            update();
            external.start();
            void refresh();
            poll = setInterval(update, 1_000);
            poll.unref();
            return view;
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
        cleanup();
        browsing = false;
        closeDashboard = undefined;
      }
      if (
        selected?.host ||
        selected?.source !== "pi" ||
        !selected.sessionFile ||
        !active
      )
        return;
      if (
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        ctx.ui.getEditorText().trim()
      ) {
        ctx.ui.notify(
          "Return to this conversation first. Finish its running work, queued messages or draft before switching.",
          "warning",
        );
        return;
      }
      if (otherOwners(selected.sessionFile).length) {
        ctx.ui.notify(
          "That session is now open in another Pi process. Use its original terminal.",
          "warning",
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Reopen saved session?",
        `${plain(selected.title, 160)}\n${plain(selected.cwd)}\n\nSessions without this extension cannot report ownership. Only continue if this conversation is closed in every other Pi process.`,
      );
      if (!confirmed || !active) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "This conversation started working. Nothing was switched.",
          "warning",
        );
        return;
      }
      // session_before_switch rechecks ownership after the confirmation. Pi handles
      // the destination's working directory and project trust. Don't use ctx afterward.
      await ctx.switchSession(selected.sessionFile);
    },
  });
}
