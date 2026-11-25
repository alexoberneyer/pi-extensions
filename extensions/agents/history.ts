import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conversationText } from "./claude.ts";
import { readableText } from "./codex.ts";
import { DescriptionReader, meaningfulTitle } from "./descriptions.ts";
import { identifier, object } from "./external.ts";
import { pathKey, plain, sources, type AgentRow } from "./state.ts";

type HistorySource = "claude" | "codex";
const claudeFile = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

async function listDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function savedRow(
  source: HistorySource,
  id: string,
  cwd: string,
  title: string,
  preview: string,
  updated: number,
): AgentRow {
  return {
    source,
    key: `${source}:${id}`,
    nativeId: id,
    cwd: pathKey(cwd),
    title: title || plain(`${sources[source]} in ${basename(cwd) || cwd}`, 160),
    preview,
    updated,
    model: "",
    current: false,
    live: false,
    status: "inactive",
    owners: [],
  };
}

export async function listClaudeHistory(
  signal: AbortSignal,
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): Promise<AgentRow[]> {
  const projects = join(configDir, "projects");
  const reader = new DescriptionReader();
  const files: Array<{ path: string; id: string }> = [];
  for (const project of await listDirectory(projects)) {
    signal.throwIfAborted();
    if (!project.isDirectory()) continue;
    const directory = join(projects, project.name);
    for (const file of await listDirectory(directory)) {
      // Top-level conversations only. Never follow symlinks or crawl subagents.
      const id = claudeFile.exec(file.name)?.[1];
      if (file.isFile() && id)
        files.push({ path: join(directory, file.name), id });
    }
  }
  const rows = new Map<string, AgentRow>();
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      for (let file = files.pop(); file; file = files.pop()) {
        signal.throwIfAborted();
        const stat = await lstat(file.path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!stat?.isFile()) continue;
        const id = file.id;
        const { head, tail } = await reader.jsonl(file.path, signal);
        const records = [...head, ...tail]
          .map(object)
          .filter(
            (entry): entry is Record<string, unknown> =>
              entry?.sessionId === id && !entry.isSidechain,
          );
        const cwd = records.find(
          (entry) => typeof entry.cwd === "string" && isAbsolute(entry.cwd),
        )?.cwd;
        if (typeof cwd !== "string") continue;
        const prompt = records.find(
          (entry) => entry.type === "user" && conversationText(entry, id, cwd),
        );
        const first = conversationText(prompt, id, cwd);
        const recent = conversationText(
          records.findLast((entry) => conversationText(entry, id, cwd)),
          id,
          cwd,
        );
        const custom = records.findLast(
          (entry) => entry.type === "custom-title",
        );
        const generated = records.findLast(
          (entry) => entry.type === "ai-title",
        );
        const title =
          meaningfulTitle(custom?.customTitle, [id]) ||
          meaningfulTitle(generated?.aiTitle, [id]) ||
          meaningfulTitle(first, [id]);
        const row = savedRow("claude", id, cwd, title, recent, stat.mtimeMs);
        if ((rows.get(row.key)?.updated ?? -Infinity) < row.updated)
          rows.set(row.key, row);
      }
    }),
  );
  signal.throwIfAborted();
  return [...rows.values()];
}

export async function listCodexHistory(
  signal: AbortSignal,
  home = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<AgentRow[]> {
  signal.throwIfAborted();
  const version = (name: string) =>
    Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1]);
  const database = (await listDirectory(home))
    .filter((file) => file.isFile() && Number.isSafeInteger(version(file.name)))
    .sort((a, b) => version(b.name) - version(a.name))[0];
  signal.throwIfAborted();
  if (!database) return [];
  const path = join(home, database.name);
  const helper = fileURLToPath(new URL("./codex-history.mjs", import.meta.url));
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", helper, path],
      {
        signal,
        timeout: 5_000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  signal.throwIfAborted();
  const records = JSON.parse(output) as unknown[];
  return records.flatMap((value) => {
    const entry = object(value);
    if (
      !entry ||
      !identifier(entry.id) ||
      typeof entry.cwd !== "string" ||
      !isAbsolute(entry.cwd)
    )
      return [];
    const ids = [entry.id];
    const first = readableText(entry.first_user_message, ids);
    const preview = readableText(entry.preview, ids) || first;
    const title =
      meaningfulTitle(entry.name, ids) ||
      meaningfulTitle(readableText(entry.title, ids), ids) ||
      meaningfulTitle(first, ids) ||
      meaningfulTitle(preview, ids);
    const updated =
      typeof entry.updated_at_ms === "number" && entry.updated_at_ms > 0
        ? entry.updated_at_ms
        : Number(entry.updated_at) * 1_000;
    return [
      {
        ...savedRow(
          "codex",
          entry.id,
          entry.cwd,
          title,
          preview,
          Number.isFinite(updated) && updated > 0 ? updated : 0,
        ),
        model: typeof entry.model === "string" ? plain(entry.model, 100) : "",
        detail: entry.archived === 1 ? "Archived in Codex" : undefined,
      },
    ];
  });
}

/** Saved metadata never replaces native status or grants attachment authority. */
export function mergeExternalHistory(
  saved: readonly AgentRow[],
  operational: readonly AgentRow[],
): AgentRow[] {
  const claimed = new Set(
    operational.filter((row) => !row.host).map((row) => row.key),
  );
  for (const row of operational) {
    if (!row.host && row.source === "claude" && row.transcriptId)
      claimed.add(`claude:${row.transcriptId}`);
  }
  return [...saved.filter((row) => !claimed.has(row.key)), ...operational];
}
