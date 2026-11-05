import { sources, type AgentRow, type AgentSource } from "./state.ts";

export const EXTERNAL_POLL_MS = 5_000;
export const DISCOVERY_TIMEOUT_MS = 4_000;

export interface SessionAdapter {
  source: Exclude<AgentSource, "pi"> | "dev01";
  timeoutMs?: number;
  list(signal: AbortSignal): Promise<AgentRow[]>;
  warning?(): string;
}

function sourceName(adapter: SessionAdapter): string {
  return adapter.source === "dev01" ? "dev01" : sources[adapter.source];
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)
  );
}

// Commands are copied, never executed. Reject invisible controls instead of
// sanitizing them into a different filesystem path or shell argument.
export function shellQuote(value: string): string {
  if (
    !value ||
    value.length > 4_096 ||
    /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(value)
  )
    throw new Error("Unsafe command argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nativeCommand(build: () => string): string | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

interface Snapshot {
  adapter: SessionAdapter;
  rows: AgentRow[];
  pending: boolean;
  message: string;
}

/** Runs only while the dashboard is open. One failed tool never hides another. */
export class ExternalSessions {
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private snapshots: Snapshot[];

  constructor(
    adapters: SessionAdapter[],
    private changed: () => void,
  ) {
    this.snapshots = adapters.map((adapter) => ({
      adapter,
      rows: [],
      pending: false,
      message: `${sourceName(adapter)} loading`,
    }));
  }

  get rows(): AgentRow[] {
    return this.snapshots.flatMap((snapshot) => snapshot.rows);
  }

  get summary(): string {
    return this.snapshots.map((snapshot) => snapshot.message).join(" · ");
  }

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), EXTERNAL_POLL_MS);
    this.timer.unref();
  }

  refresh(): void {
    if (this.abort.signal.aborted) return;
    for (const snapshot of this.snapshots) {
      if (snapshot.pending) continue;
      snapshot.pending = true;
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(snapshot.adapter.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
      ]);
      void this.poll(snapshot, signal);
    }
  }

  private async poll(snapshot: Snapshot, signal: AbortSignal): Promise<void> {
    const name = sourceName(snapshot.adapter);
    try {
      const rows = await snapshot.adapter.list(signal);
      signal.throwIfAborted();
      snapshot.rows = rows;
      snapshot.message = [
        `${name} ${rows.length}`,
        snapshot.adapter.warning?.(),
      ]
        .filter(Boolean)
        .join(" · ");
    } catch {
      if (this.abort.signal.aborted) return;
      snapshot.message = `${name} unavailable (Ctrl+R retries)`;
      snapshot.rows = snapshot.rows.map((row) => ({
        ...row,
        status: "unknown",
        live: false,
        nativeCommand: undefined,
        tmux: undefined,
        remoteTmux: undefined,
        detail: `${name} discovery unavailable. Last seen data, not a current status.`,
      }));
    } finally {
      snapshot.pending = false;
      if (!this.abort.signal.aborted) this.changed();
    }
  }

  dispose(): void {
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
  }
}
