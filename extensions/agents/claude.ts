import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { DescriptionReader, meaningfulTitle } from "./descriptions.ts";
import {
  identifier,
  nativeCommand,
  object,
  shellQuote,
  type SessionAdapter,
} from "./external.ts";
import {
  pathKey,
  plain,
  textContent,
  type AgentRow,
  type Status,
} from "./state.ts";

export function claudeRows(
  value: unknown,
  configDir?: string,
  remote = false,
): AgentRow[] {
  if (!Array.isArray(value)) throw new Error("Unsupported Claude session list");
  const rows = new Map<string, AgentRow>();
  for (const item of value) {
    const session = object(item);
    if (!session) continue;
    const id = session.sessionId ?? session.id;
    if (
      !identifier(id) ||
      typeof session.cwd !== "string" ||
      !isAbsolute(session.cwd)
    )
      continue;
    const cwd = session.cwd;
    const background = session.kind === "background";
    const pid =
      typeof session.pid === "number" &&
      Number.isSafeInteger(session.pid) &&
      session.pid > 0
        ? session.pid
        : undefined;
    const live = pid !== undefined;
    // status describes the live process. state describes the background job.
    // In particular, a job marked done may still have an idle live process.
    const status: Status =
      session.status === "waiting"
        ? "waiting"
        : session.status === "busy"
          ? "working"
          : session.status === "idle"
            ? "ready"
            : session.state === "blocked"
              ? "waiting"
              : "unknown";
    const attachId = identifier(session.id) ? session.id : id;
    const command = background
      ? nativeCommand(() => {
          const env = configDir
            ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} `
            : "";
          return `cd -- ${shellQuote(cwd)} && ${env}claude attach ${shellQuote(attachId)}`;
        })
      : undefined;
    const detail = [
      `Claude ${background ? "background" : "interactive"}`,
      `Conversation ${id}`,
      live ? `PID ${pid}` : "No live PID reported",
      `Native status: ${plain(String(session.status ?? "unknown"), 50)}`,
      ...(typeof session.state === "string"
        ? [`job: ${plain(session.state, 50)}`]
        : []),
      background ? "Enter shows attach command" : "Use its original terminal",
    ].join(" · ");
    rows.set(`claude:${id}`, {
      source: "claude",
      key: `claude:${id}`,
      nativeId: id,
      live,
      pid,
      cwd: remote ? cwd : pathKey(cwd),
      title:
        meaningfulTitle(session.name, [id, attachId]) ||
        plain(`Claude in ${basename(cwd) || cwd}`, 160),
      preview:
        typeof session.waitingFor === "string" ? plain(session.waitingFor) : "",
      model: "",
      status,
      // The CLI does not always expose an activity timestamp. Do not present
      // process start time or time of polling as the session's last activity.
      updated:
        typeof session.statusUpdatedAt === "number" &&
        Number.isFinite(session.statusUpdatedAt)
          ? session.statusUpdatedAt
          : 0,
      current: false,
      owners: [],
      detail,
      nativeCommand: command,
    });
  }
  if (value.length && !rows.size)
    throw new Error("Unsupported Claude session records");
  return [...rows.values()];
}

function conversationText(value: unknown, id: string, cwd: string): string {
  const entry = object(value);
  if (
    !entry ||
    entry.sessionId !== id ||
    entry.cwd !== cwd ||
    entry.isMeta ||
    entry.isSidechain ||
    entry.isCompactSummary ||
    !["user", "assistant"].includes(String(entry.type))
  )
    return "";
  const message = object(entry.message);
  if (!message || message.role !== entry.type) return "";
  const clean = (text: string) =>
    text.replace(
      /<(system-reminder|task-notification|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|environment_context|user_instructions|instructions)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    );
  const content =
    typeof message.content === "string"
      ? clean(message.content)
      : Array.isArray(message.content)
        ? message.content.map((value) => {
            const block = object(value);
            return block?.type === "text" && typeof block.text === "string"
              ? { type: "text", text: clean(block.text) }
              : undefined;
          })
        : [];
  return textContent({ content });
}

export async function describeClaudeSession(
  row: AgentRow,
  session: Record<string, unknown>,
  configDir: string,
  reader: DescriptionReader,
  signal: AbortSignal,
): Promise<AgentRow> {
  const id = row.nativeId!;
  const shortId = identifier(session.id) ? session.id : id.slice(0, 8);
  const stored = object(
    await reader.json(join(configDir, "jobs", shortId, "state.json"), signal),
  );
  // Job text is display evidence only. Never let it change status or attachment.
  const job =
    stored?.sessionId === id && stored.cwd === session.cwd ? stored : undefined;
  const transcriptId = identifier(job?.resumeSessionId)
    ? job.resumeSessionId
    : id;
  const project = String(session.cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const edges = await reader.jsonl(
    join(configDir, "projects", project, `${transcriptId}.jsonl`),
    signal,
  );
  const firstUser = edges.head.find(
    (entry) =>
      object(entry)?.type === "user" &&
      conversationText(entry, transcriptId, String(session.cwd)),
  );
  const recent = [...edges.head, ...edges.tail]
    .map((entry) => conversationText(entry, transcriptId, String(session.cwd)))
    .filter(Boolean)
    .at(-1);
  const name = meaningfulTitle(session.name, [id, shortId]);
  const firstPrompt =
    meaningfulTitle(
      conversationText(firstUser, transcriptId, String(session.cwd)),
    ) || meaningfulTitle(job?.intent);
  const projectPrefix = `${basename(String(session.cwd)).toLowerCase()}-`;
  const generatedName =
    name.toLowerCase().startsWith(projectPrefix) &&
    /^[a-f0-9]{2,8}$/i.test(name.slice(projectPrefix.length));
  const empty =
    job?.needs === "send a prompt to start" && !firstPrompt && !recent;
  const question =
    row.status === "waiting" && typeof job?.needs === "string"
      ? plain(job.needs)
      : "";
  return {
    ...row,
    title:
      (generatedName ? "" : name) ||
      firstPrompt ||
      name ||
      (empty ? "New session · awaiting first prompt" : row.title),
    preview:
      row.preview ||
      question ||
      recent ||
      (empty ? "Awaiting first prompt." : ""),
  };
}

export function createClaudeAdapter(): SessionAdapter {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const root = configDir || join(homedir(), ".claude");
  const reader = new DescriptionReader();
  return {
    source: "claude",
    async list(signal) {
      signal.throwIfAborted();
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "claude",
          ["agents", "--json"],
          {
            cwd: homedir(),
            signal,
            killSignal: "SIGKILL", // Only the short-lived discovery helper, never a session.
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout) => {
            // execFile does not forward killSignal to its AbortSignal handler.
            // Stop this discovery helper even if it ignores the initial SIGTERM.
            if (signal.aborted) child.kill("SIGKILL");
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
      const value: unknown = JSON.parse(output);
      const rows = claudeRows(value, configDir);
      const sessions = new Map(
        (value as Record<string, unknown>[])
          .filter((session) => object(session))
          .map((session) => [session.sessionId ?? session.id, session]),
      );
      return Promise.all(
        rows.map((row) =>
          describeClaudeSession(
            row,
            sessions.get(row.nativeId)!,
            root,
            reader,
            signal,
          ),
        ),
      );
    },
  };
}
