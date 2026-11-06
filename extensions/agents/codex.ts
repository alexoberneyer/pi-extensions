import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { DescriptionReader, meaningfulTitle } from "./descriptions.ts";
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

function descriptionIds(thread: Record<string, unknown>): string[] {
  return [thread.id, thread.sessionId].filter(
    (id): id is string => typeof id === "string",
  );
}

// These arrive as user-role messages too, but are not the user's task.
function readableText(value: unknown, ids: string[]): string {
  if (typeof value !== "string") return "";
  let text = value;
  if (/^\s*#\s*AGENTS\.md instructions\b/i.test(text)) {
    const end = /<\/INSTRUCTIONS\s*>/i.exec(text);
    if (!end) return "";
    text = text.slice(end.index + end[0].length);
  }
  text = text
    .replace(
      /<(environment_context|environment|user_instructions|instructions|system|developer|turn_aborted)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    )
    .replace(/^\s*#\s*AGENTS\.md instructions[^\r\n]*(?:\r?\n|$)/gim, "");
  const result = plain(text);
  return meaningfulTitle(result, ids) ? result : "";
}

function rolloutMessage(
  value: unknown,
  ids: string[],
): { role: "user" | "assistant"; text: string } | undefined {
  const record = object(value);
  const payload = object(record?.payload);
  if (!payload) return;
  if (record?.type === "event_msg") {
    const role =
      payload.type === "user_message"
        ? "user"
        : payload.type === "agent_message"
          ? "assistant"
          : undefined;
    const text = readableText(payload.message, ids);
    return role && text ? { role, text } : undefined;
  }
  if (
    record?.type !== "response_item" ||
    payload.type !== "message" ||
    (payload.role !== "user" && payload.role !== "assistant") ||
    (payload.channel != null &&
      payload.channel !== "final" &&
      payload.channel !== "commentary") ||
    (payload.recipient != null && payload.recipient !== "all")
  )
    return;
  const text = Array.isArray(payload.content)
    ? plain(
        payload.content
          .map((value) => {
            const block = object(value);
            return block?.type === "text" ||
              block?.type ===
                (payload.role === "user" ? "input_text" : "output_text")
              ? readableText(block.text, ids)
              : "";
          })
          .filter(Boolean)
          .join(" "),
      )
    : readableText(payload.content, ids);
  return text ? { role: payload.role, text } : undefined;
}

function inputQuestion(value: unknown, ids: string[]): string {
  const record = object(value);
  const payload = object(record?.payload);
  if (
    record?.type !== "response_item" ||
    payload?.type !== "function_call" ||
    (payload.name !== "request_user_input" &&
      payload.name !== "functions.request_user_input")
  )
    return "";
  try {
    const args = object(
      typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments)
        : payload.arguments,
    );
    if (!Array.isArray(args?.questions)) return "";
    for (const question of args.questions) {
      const text = readableText(object(question)?.question, ids);
      if (text) return text;
    }
  } catch {
    // Never show raw tool arguments, even if they cannot be parsed.
  }
  return "";
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
  const cwd = pathKey(thread.cwd);
  const ids = descriptionIds(thread);
  const preview = readableText(thread.preview, ids);
  return {
    source: "codex",
    key: `codex:${id}`,
    nativeId: id,
    live: true,
    cwd,
    title:
      meaningfulTitle(thread.name, ids) ||
      meaningfulTitle(preview, ids) ||
      `Codex in ${plain(basename(cwd), 120) || "project"}`,
    preview,
    model: plain(typeof thread.model === "string" ? thread.model : "", 100),
    status,
    updated:
      typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
        ? thread.updatedAt * 1_000
        : 0,
    current: false,
    owners: [],
    detail: `Codex loaded thread · ${plain(String(runtime?.type ?? "unknown"), 50)}${flags.length ? ` · ${plain(flags.join(", "), 150)}` : ""} · Enter shows native resume command`,
    nativeCommand: nativeCommand(
      () =>
        `codex resume --remote ${shellQuote(`unix://${socketPath}`)} ${shellQuote(id)}`,
    ),
  };
}

// Rollouts enrich descriptions only. Native identity, status and ownership are
// exclusively app-server data, including when the rollout is missing/corrupt.
export async function enrichCodexRow(
  value: unknown,
  row: AgentRow,
  reader: DescriptionReader,
  codexHome: string,
  signal: AbortSignal,
): Promise<AgentRow> {
  signal.throwIfAborted();
  const thread = object(value);
  if (
    !thread ||
    thread.id !== row.nativeId ||
    typeof thread.cwd !== "string" ||
    typeof thread.path !== "string" ||
    !isAbsolute(thread.path)
  )
    return row;
  try {
    const stat = await lstat(thread.path);
    signal.throwIfAborted();
    if (!stat.isFile() || stat.isSymbolicLink()) return row;
    const [home, file] = await Promise.all([
      realpath(codexHome),
      realpath(thread.path),
    ]);
    signal.throwIfAborted();
    if (
      !["sessions", "archived_sessions"].some((directory) => {
        const path = relative(join(home, directory), file);
        return (
          path !== "" &&
          path !== ".." &&
          !path.startsWith(`..${sep}`) &&
          !isAbsolute(path)
        );
      })
    )
      return row;
    const { head, tail, gap } = await reader.jsonl(file, signal);
    const metadata = head.filter(
      (record) => object(record)?.type === "session_meta",
    );
    if (
      !metadata.length ||
      [
        ...metadata,
        ...tail.filter((record) => object(record)?.type === "session_meta"),
      ].some((record) => {
        const meta = object(object(record)?.payload);
        return meta?.id !== thread.id || meta?.cwd !== thread.cwd;
      })
    )
      return row;
    const ids = descriptionIds(thread);
    let initial = readableText(thread.preview, ids);
    let recent = "";
    let pendingQuestion: { callId: unknown; text: string } | undefined;
    const runtime = object(thread.status);
    const waiting =
      runtime?.type === "active" &&
      Array.isArray(runtime.activeFlags) &&
      runtime.activeFlags.includes("waitingOnUserInput");
    for (const [edge, records] of [head, tail].entries()) {
      // An answer may be in the unread middle. Only questions observed in the
      // recent window can be considered pending after crossing that gap.
      if (edge === 1 && gap) pendingQuestion = undefined;
      for (const record of records) {
        const message = rolloutMessage(record, ids);
        if (message) {
          if (!initial && edge === 0 && message.role === "user")
            initial = message.text;
          recent = message.text;
        }
        if (waiting) {
          const payload = object(object(record)?.payload);
          const question = inputQuestion(record, ids);
          if (question)
            pendingQuestion = { callId: payload?.call_id, text: question };
          else if (
            payload?.type === "function_call_output" &&
            typeof pendingQuestion?.callId === "string" &&
            payload.call_id === pendingQuestion.callId
          )
            pendingQuestion = undefined;
        }
      }
    }
    // Only call a session empty when the complete, canonical rollout consists
    // solely of its metadata. Empty native previews / includeTurns:false do not
    // prove emptiness. The byte check also excludes skipped corrupt lines.
    const empty =
      thread.preview === "" &&
      head.length === 1 &&
      tail.length === 0 &&
      stat.size === Buffer.byteLength(`${JSON.stringify(head[0])}\n`);
    return {
      ...row,
      title:
        meaningfulTitle(thread.name, ids) ||
        meaningfulTitle(initial, ids) ||
        (empty ? "New session" : row.title),
      preview: pendingQuestion?.text || recent || row.preview,
    };
  } catch {
    signal.throwIfAborted();
    return row;
  }
}

export function createCodexAdapter(
  socketPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  ),
): SessionAdapter {
  const reader = new DescriptionReader();
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
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
              if (row)
                rows.push(
                  await enrichCodexRow(
                    result?.thread,
                    row,
                    reader,
                    codexHome,
                    signal,
                  ),
                );
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
