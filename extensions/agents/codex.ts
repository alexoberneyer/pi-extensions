import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  identifier,
  nativeCommand,
  object,
  shellQuote,
  type SessionAdapter,
} from "./external.ts";
import { pathKey, plain, type AgentRow, type Status } from "./state.ts";

type ReadMethod = "initialize" | "thread/loaded/list" | "thread/read";

// Connect only to an existing local Unix socket. Never start a daemon, resume
// a thread, subscribe to its turns or answer server-initiated approval requests.
async function connect(socketPath: string, signal: AbortSignal) {
  const { default: WebSocket } = await import("ws");
  signal.throwIfAborted();
  const ws = new WebSocket("ws://localhost/", {
    createConnection: () => createConnection({ path: socketPath }),
    perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
  });
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  let rejectOpen: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    ws.once("open", resolve);
  });
  function close(error = new Error("Codex connection closed")) {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    rejectOpen(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    ws.terminate();
  }
  function abort() {
    close(new Error("Codex discovery cancelled"));
  }
  signal.addEventListener("abort", abort, { once: true });
  ws.on("error", () => close(new Error("Codex daemon unavailable")));
  ws.on("close", () => close());
  ws.on("message", (raw, binary) => {
    try {
      if (binary) throw new Error("Expected JSON response");
      const response = object(JSON.parse(raw.toString()));
      if (!response) throw new Error("Expected JSON object");
      if (typeof response.method === "string") return; // Notifications / requests aren't ours.
      if (typeof response.id !== "number") return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error)
        request.reject(new Error("Codex read request failed"));
      else if ("result" in response) request.resolve(response.result);
      else request.reject(new Error("Unsupported Codex response"));
    } catch {
      close(new Error("Invalid Codex response"));
    }
  });
  await opened;
  return {
    close,
    initialized() {
      ws.send(JSON.stringify({ method: "initialized" }));
    },
    request(
      method: ReadMethod,
      params: Record<string, unknown>,
    ): Promise<unknown> {
      if (closed || signal.aborted)
        return Promise.reject(new Error("Codex connection closed"));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) close(new Error("Codex send failed"));
        });
      });
    },
  };
}

export function codexRow(
  value: unknown,
  socketPath: string,
): AgentRow | undefined {
  const thread = object(value);
  if (
    !thread ||
    !identifier(thread.id) ||
    typeof thread.cwd !== "string" ||
    !isAbsolute(thread.cwd)
  )
    throw new Error("Unsupported Codex thread");
  const runtime = object(thread.status);
  if (runtime?.type === "notLoaded") return undefined; // Unloaded during the poll.
  const flags = Array.isArray(runtime?.activeFlags) ? runtime.activeFlags : [];
  const knownFlags =
    Array.isArray(runtime?.activeFlags) &&
    flags.every(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    );
  const status: Status =
    runtime?.type === "idle"
      ? "ready"
      : runtime?.type === "systemError"
        ? "error"
        : runtime?.type === "active" && knownFlags
          ? flags.includes("waitingOnApproval") ||
            flags.includes("waitingOnUserInput")
            ? "waiting"
            : "working"
          : "unknown";
  const id = thread.id;
  return {
    source: "codex",
    key: `codex:${id}`,
    live: true,
    cwd: pathKey(thread.cwd),
    title: plain(
      (typeof thread.name === "string" && thread.name) ||
        (typeof thread.preview === "string" && thread.preview) ||
        id,
      160,
    ),
    preview: plain(typeof thread.preview === "string" ? thread.preview : ""),
    model: plain(typeof thread.model === "string" ? thread.model : "", 100),
    status,
    updated:
      typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
        ? thread.updatedAt * 1_000
        : 0,
    current: false,
    owners: [],
    detail: `Codex loaded thread · ${plain(String(runtime?.type ?? "unknown"), 50)}${flags.length ? ` · ${plain(flags.join(", "), 150)}` : ""} · Preview is the initial prompt · Enter shows native resume command`,
    nativeCommand: nativeCommand(
      () =>
        `codex resume --remote ${shellQuote(`unix://${socketPath}`)} ${shellQuote(id)}`,
    ),
  };
}

export function createCodexAdapter(
  socketPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  ),
): SessionAdapter {
  return {
    source: "codex",
    async list(signal) {
      const client = await connect(socketPath, signal);
      try {
        await client.request("initialize", {
          clientInfo: { name: "pi_agents_dashboard", version: "1.0.0" },
        });
        client.initialized();
        const ids = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const page = object(
            await client.request("thread/loaded/list", { limit: 100, cursor }),
          );
          if (
            !page ||
            !Array.isArray(page.data) ||
            !page.data.every(identifier)
          )
            throw new Error("Unsupported Codex loaded list");
          for (const id of page.data) ids.add(id);
          if (page.nextCursor != null && typeof page.nextCursor !== "string")
            throw new Error("Unsupported Codex cursor");
          cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
          if (cursor !== null) {
            if (cursors.has(cursor)) throw new Error("Repeated Codex cursor");
            cursors.add(cursor);
          }
        } while (cursor !== null);
        const rows: AgentRow[] = [];
        // Bound simultaneous requests without serializing every loaded session.
        const remaining = [...ids];
        await Promise.all(
          Array.from({ length: Math.min(4, remaining.length) }, async () => {
            for (
              let id = remaining.pop();
              id !== undefined;
              id = remaining.pop()
            ) {
              const result = object(
                await client.request("thread/read", {
                  threadId: id,
                  includeTurns: false,
                }),
              );
              const row = codexRow(result?.thread, socketPath);
              if (row && row.key !== `codex:${id}`)
                throw new Error("Codex thread identity mismatch");
              if (row) rows.push(row);
            }
          }),
        );
        return rows;
      } finally {
        client.close();
      }
    },
  };
}
