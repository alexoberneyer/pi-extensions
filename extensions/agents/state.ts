import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isTmuxPane, type TmuxPane, type TmuxTarget } from "./tmux-target.ts";
import type { RemoteTmuxTarget } from "./remote-target.ts";

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;
export const statuses = {
  waiting: "Needs you",
  working: "Working",
  ready: "Idle",
  error: "Error",
  stopped: "Stopped",
  unknown: "State unavailable",
  inactive: "Saved",
} as const;
export type Status = keyof typeof statuses;
export type LiveStatus = Exclude<Status, "inactive" | "unknown">;
export const filters = [
  "Sessions",
  "Needs you",
  "Working",
  "Idle",
  "History",
  "All",
] as const;

export interface Presence {
  version: 1;
  instance: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  title: string;
  preview: string;
  model: string;
  status: LiveStatus;
  updated: number;
  heartbeat: number;
  tmux?: TmuxPane;
}

export interface SavedSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  allMessagesText: string;
  modified: Date;
}

export const sources = {
  pi: "Pi",
  claude: "Claude",
  codex: "Codex",
  tmux: "tmux",
} as const;
export type AgentSource = keyof typeof sources;

export interface AgentRow {
  source: AgentSource;
  host?: string;
  key: string;
  live: boolean;
  detail?: string;
  nativeCommand?: string;
  tmux?: TmuxTarget;
  remoteTmux?: RemoteTmuxTarget;
  tmuxName?: string;
  tmuxAgent?: Exclude<AgentSource, "tmux">;
  tmuxPids?: number[];
  pid?: number;
  sessionFile?: string;
  cwd: string;
  title: string;
  preview: string;
  model: string;
  status: Status;
  updated: number;
  current: boolean;
  owners: Presence[];
}

// Never let session text inject terminal controls, OSC links or bidi overrides.
export function plain(value: string, limit = 1_200): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function textContent(message: { content?: unknown }): string {
  if (typeof message.content === "string") return plain(message.content);
  if (!Array.isArray(message.content)) return "";
  return plain(
    message.content
      .filter(
        (block) => block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join(" "),
  );
}

export function pathKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isPresence(value: unknown): value is Presence {
  if (!value || typeof value !== "object") return false;
  const p = value as Presence;
  return (
    p.version === 1 &&
    typeof p.instance === "string" &&
    Number.isSafeInteger(p.pid) &&
    p.pid > 0 &&
    typeof p.sessionId === "string" &&
    (p.sessionFile === undefined || typeof p.sessionFile === "string") &&
    [p.cwd, p.title, p.preview, p.model].every((v) => typeof v === "string") &&
    ["waiting", "working", "ready", "error", "stopped"].includes(p.status) &&
    Number.isFinite(p.updated) &&
    Number.isFinite(p.heartbeat)
  );
}

/** One private, atomic presence record per extension runtime. Not a session lock. */
export class Registry {
  readonly instance = randomUUID();
  readonly file: string;

  constructor(readonly directory: string) {
    this.file = join(directory, `${this.instance}.json`);
  }

  write(
    presence: Omit<Presence, "version" | "instance" | "pid" | "heartbeat">,
  ): Presence {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const record: Presence = {
      ...presence,
      version: 1,
      instance: this.instance,
      pid: process.pid,
      heartbeat: Date.now(),
    };
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      this.remove(temporary);
    }
    return record;
  }

  list(alive = isProcessAlive): Presence[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: Presence[] = [];
    for (const name of names) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const file = join(this.directory, name);
      let record: unknown;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > 16_384) continue;
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue; // Another instance may exit between readdir and read.
      }
      if (!isPresence(record)) continue;
      if (alive(record.pid))
        result.push(
          isTmuxPane(record.tmux) ? record : { ...record, tmux: undefined },
        );
      // Dead records are ignored, not deleted: readers never race a writer's cleanup.
    }
    return result;
  }

  dispose(): void {
    this.remove(this.file);
  }

  private remove(file: string): void {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function mergeRows(
  history: SavedSession[],
  live: Presence[],
  currentInstance: string,
  now = Date.now(),
): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const session of history) {
    const key = pathKey(session.path);
    rows.set(key, {
      source: "pi",
      live: false,
      key,
      sessionFile: session.path,
      cwd: session.cwd ? pathKey(session.cwd) : "",
      title: plain(
        session.name || session.firstMessage || "Untitled session",
        160,
      ),
      preview: plain(session.allMessagesText.slice(-1_200)),
      model: "",
      status: "inactive",
      updated: session.modified.getTime(),
      current: false,
      owners: [],
    });
  }
  for (const record of live) {
    const key = record.sessionFile
      ? pathKey(record.sessionFile)
      : `live:${record.instance}`;
    const previous = rows.get(key);
    const owners = [...(previous?.owners ?? []), record];
    const freshest = owners.reduce((a, b) =>
      a.heartbeat >= b.heartbeat ? a : b,
    );
    rows.set(key, {
      source: "pi",
      live: true,
      key,
      sessionFile: freshest.sessionFile,
      cwd: freshest.cwd ? pathKey(freshest.cwd) : "",
      title: plain(
        freshest.title || previous?.title || "Untitled session",
        160,
      ),
      preview: plain(freshest.preview),
      model: plain(freshest.model, 100),
      status:
        owners.length > 1 || now - freshest.heartbeat > STALE_MS
          ? "unknown"
          : freshest.status,
      updated: freshest.updated,
      current: owners.some((owner) => owner.instance === currentInstance),
      owners,
    });
  }
  return [...rows.values()];
}

export function filterRows(
  rows: AgentRow[],
  filter: number,
  query: string,
  cwd?: string,
  source?: AgentSource,
): AgentRow[] {
  const terms = plain(query).toLocaleLowerCase().split(" ").filter(Boolean);
  return rows.filter((row) => {
    if (cwd !== undefined && (row.host || row.cwd !== cwd)) return false;
    if (
      source !== undefined &&
      (source === "tmux"
        ? row.source !== "tmux" && !row.tmux
        : row.source !== source)
    )
      return false;
    if (filter === 0 && row.status === "inactive") return false;
    if (filter === 1 && !["waiting", "error", "stopped"].includes(row.status))
      return false;
    if (filter === 2 && row.status !== "working") return false;
    if (filter === 3 && row.status !== "ready") return false;
    if (filter === 4 && row.status !== "inactive") return false;
    const text =
      `${sources[row.source]} ${row.host || "local"} ${row.title} ${row.cwd} ${row.preview} ${row.model} ${row.tmux ? "tmux" : ""} ${row.tmuxName || ""}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function age(timestamp: number, now = Date.now()): string {
  if (!timestamp) return "?";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
