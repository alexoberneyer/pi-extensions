import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readConfig } from "../../lib/config.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeRows } from "./claude.ts";
import {
  nativeCommand,
  object,
  shellQuote,
  type SessionAdapter,
} from "./external.ts";
import {
  isRemoteTmuxTarget,
  isSshHost,
  type RemoteTmuxTarget,
} from "./remote-target.ts";
import { isTmuxPane } from "./tmux-target.ts";
import {
  isPresence,
  plain,
  STALE_MS,
  type AgentRow,
  type AgentSource,
  type Presence,
} from "./state.ts";

// Resolve package helpers from the real file, including symlinked entry points.
const { attachCommand, snapshot } = await import(
  new URL(
    "../../bin/dev01.mjs",
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
  ).href
);

interface Pane {
  socket?: unknown;
  id: string;
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  command: string;
}

export function dev01Rows(value: unknown): AgentRow[] {
  if (!readConfig().remote.host) return [];
  const data = object(value);
  if (
    data?.version !== 1 ||
    !Array.isArray(data.panes) ||
    !Array.isArray(data.claude) ||
    !Array.isArray(data.pi) ||
    typeof data.now !== "number" ||
    !Number.isFinite(data.now)
  )
    throw new Error("Unsupported dev01 response");
  const host = data.sshHost;
  if (!isSshHost(host))
    throw new Error("Unsupported dev01 SSH destination. Refresh /agents.");
  const panes = new Map<string, Pane>();
  for (const value of data.panes) {
    const pane = object(value);
    if (
      !pane ||
      typeof pane.id !== "string" ||
      !/^%\d+$/.test(pane.id) ||
      /\s/.test(pane.id) ||
      typeof pane.sessionId !== "string" ||
      !/^\$\d+$/.test(pane.sessionId) ||
      /\s/.test(pane.sessionId) ||
      !Number.isSafeInteger(pane.pid) ||
      Number(pane.pid) <= 0 ||
      ![pane.cwd, pane.name, pane.command].every((s) => typeof s === "string")
    )
      throw new Error("Unsupported dev01 pane");
    panes.set(pane.id, pane as unknown as Pane);
  }
  const targetFor = (id: unknown): RemoteTmuxTarget | undefined => {
    if (typeof id !== "string") return undefined;
    const pane = panes.get(id);
    if (!pane) return undefined;
    // Validate syntax only. The socket and all process/path checks belong to dev01.
    const target = {
      host: "dev01",
      sshHost: host,
      socket: pane.socket,
      session: pane.sessionId,
      pane: pane.id,
    };
    return isRemoteTmuxTarget(target) ? target : undefined;
  };
  // Never feed these records into the local Registry or pathKey(). Their PIDs
  // were checked on dev01. Use dev01's clock to evaluate heartbeat freshness.
  const groups = new Map<
    string,
    Array<{ record: Presence; pane: unknown; target?: RemoteTmuxTarget }>
  >();
  const piClaims = new Map<string, number>();
  for (const item of data.pi) {
    const entry = object(item);
    if (!isPresence(entry?.record) || !isAbsolute(entry.record.cwd)) continue;
    const record = entry.record;
    // Ancestry also matches headless children. Only exact interactive presence
    // protects a pane, even when stale, duplicated or missing ancestry evidence.
    const target =
      isTmuxPane(record.tmux) &&
      panes.get(record.tmux.pane)?.socket === record.tmux.socket
        ? targetFor(record.tmux.pane)
        : undefined;
    if (target) piClaims.set(target.pane, (piClaims.get(target.pane) ?? 0) + 1);
    const key = record.sessionFile || `live:${record.instance}`;
    const group = groups.get(key) || [];
    group.push({ record, pane: entry.pane, target });
    groups.set(key, group);
  }
  // Pi ownership takes precedence over nested Claude and tmux fallback rows.
  const used = new Set(piClaims.keys());
  const sessions = data.claude.map((item) => object(item));
  if (sessions.some((item) => !object(item?.record)))
    throw new Error("Unsupported dev01 Claude record");
  const rows = claudeRows(
    sessions.map((item) => item!.record),
    typeof data.claudeConfigDir === "string" ? data.claudeConfigDir : undefined,
    true,
  ).map((row): AgentRow => {
    const session = sessions.find((item) => {
      const record = object(item!.record)!;
      return `claude:${record.sessionId ?? record.id}` === row.key;
    })!;
    const protectedByPi =
      typeof session.pane === "string" && piClaims.has(session.pane);
    if (typeof session.pane === "string" && panes.has(session.pane))
      used.add(session.pane);
    const remoteTmux = protectedByPi ? undefined : targetFor(session.pane);
    const attach = remoteTmux && attachCommand(remoteTmux);
    return {
      ...row,
      host: "dev01",
      key: `dev01:${row.key}`,
      remoteTmux,
      nativeCommand: protectedByPi
        ? undefined
        : attach ||
          (row.nativeCommand &&
            nativeCommand(
              () =>
                `ssh -t ${host} ${shellQuote(`bash -lc ${shellQuote(row.nativeCommand!)}`)}`,
            )),
      detail: `dev01 · ${protectedByPi ? "Pane owned by tracked Pi. Use the Pi row." : attach ? "Attach to the existing tmux session" : row.detail}`,
    };
  });

  for (const [key, group] of groups) {
    const { record, pane, target } = group.reduce((a, b) =>
      a.record.heartbeat >= b.record.heartbeat ? a : b,
    );
    const stale = data.now - record.heartbeat > STALE_MS;
    const multipleOwners =
      group.length > 1 ||
      group.some(
        (entry) => entry.target && (piClaims.get(entry.target.pane) ?? 0) > 1,
      );
    const remoteTmux =
      !stale && !multipleOwners && target?.pane === pane ? target : undefined;
    rows.push({
      source: "pi",
      host: "dev01",
      key: `dev01:pi:${key}`,
      live: true,
      cwd: record.cwd,
      title: plain(record.title, 160),
      preview: plain(record.preview),
      model: plain(record.model, 100),
      status: stale || multipleOwners ? "unknown" : record.status,
      updated: record.updated,
      current: false,
      owners: [],
      remoteTmux,
      nativeCommand: remoteTmux && attachCommand(remoteTmux),
      detail: multipleOwners
        ? "dev01 · Multiple tracked owners. Check the original terminals."
        : stale
          ? "dev01 · Stale heartbeat. The remote process may still own this session."
          : remoteTmux
            ? "dev01 · Remote Pi. Attach to tmux; never resume this conversation on the Mac."
            : "dev01 · Remote Pi status only. No confirmed tmux terminal. Never resume this conversation on the Mac.",
    });
  }
  for (const pane of panes.values()) {
    if (used.has(pane.id)) continue;
    const source: AgentSource = ["pi", "claude", "codex"].includes(pane.command)
      ? (pane.command as AgentSource)
      : "tmux";
    const remoteTmux = targetFor(pane.id);
    rows.push({
      source,
      host: "dev01",
      key: `dev01:tmux:${pane.id}`,
      live: true,
      cwd: pane.cwd,
      title: plain(pane.name, 160),
      preview: "",
      model: "",
      status: "unknown",
      updated: 0,
      current: false,
      owners: [],
      remoteTmux,
      nativeCommand: remoteTmux && attachCommand(remoteTmux),
      detail: `dev01 · tmux ${pane.id} · ${plain(pane.command, 80)} · ${source === "pi" ? "No Pi status record. Install the Agents extension and run /reload in this Pi session." : "No native agent status. A pane is not proof of working or completed work."}`,
    });
  }
  return rows;
}

export function createDev01Adapter(): SessionAdapter {
  let previous: AgentRow[] = [];
  let warning = "";
  return {
    source: "dev01",
    timeoutMs: 10_000,
    warning: () => warning,
    async list(signal) {
      if (!readConfig().remote.host) {
        previous = [];
        warning = "";
        return [];
      }
      const data = await snapshot(signal);
      const errors: string[] = data.errors ?? [];
      if (
        !Array.isArray(errors) ||
        errors.some(
          (name) => !["claude", "pi", "tmux", "processes"].includes(name),
        )
      )
        throw new Error("Unsupported dev01 source errors");
      let rows: AgentRow[];
      // An unsupported Claude schema must not discard Pi and tmux either.
      try {
        rows = dev01Rows(data);
      } catch {
        rows = dev01Rows({ ...data, claude: [] });
        if (!errors.includes("claude")) errors.push("claude");
      }
      signal.throwIfAborted();
      warning = errors.length ? `dev01 unavailable: ${errors.join(", ")}` : "";
      const stale = previous
        .filter((row) => {
          const source = row.key.split(":")[1];
          return (
            errors.includes(source) &&
            !rows.some(
              (fresh) =>
                fresh.key === row.key ||
                (row.nativeCommand &&
                  fresh.nativeCommand === row.nativeCommand),
            )
          );
        })
        .map(
          (row): AgentRow => ({
            ...row,
            status: "unknown",
            live: false,
            nativeCommand: undefined,
            remoteTmux: undefined,
            detail:
              "dev01 source unavailable. Last seen data, not a current status.",
          }),
        );
      previous = [...rows, ...stale];
      return previous;
    },
  };
}
