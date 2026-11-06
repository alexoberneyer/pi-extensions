import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import {
  DISCOVERY_TIMEOUT_MS,
  shellQuote,
  type SessionAdapter,
} from "./external.ts";
import {
  pathKey,
  plain,
  sources,
  type AgentRow,
  type Presence,
} from "./state.ts";
import { isTmuxTarget, type TmuxTarget } from "./tmux-target.ts";
import { meaningfulTitle } from "./descriptions.ts";

export const PANE_FORMAT = [
  "#{socket_path}",
  "#{session_id}",
  "#{pane_id}",
  "#{pane_dead}",
  "#{?pane_current_path,#{pane_current_path},#{pane_start_path}}",
  "#{session_name}",
  "#{@pi-agents-agent}",
  "#{pane_pid}",
  "#{s/[\t\r\n]/ /:pane_title}",
].join("\t");

function positivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function processTree(output?: string): Map<number, number[]> | undefined {
  if (output === undefined) return undefined;
  const children = new Map<number, number[]>();
  const seen = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    // A malformed or oversized snapshot cannot establish process ownership.
    if (
      !positivePid(pid) ||
      !Number.isSafeInteger(parent) ||
      seen.has(pid) ||
      seen.size >= 100_000
    )
      return undefined;
    seen.add(pid);
    if (!children.has(pid)) children.set(pid, []);
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  // Do not treat a parent mentioned only in a child record as a live root.
  for (const pid of children.keys()) if (!seen.has(pid)) children.delete(pid);
  return children;
}

function descendantPids(
  pid: number | undefined,
  tree: Map<number, number[]> | undefined,
): number[] | undefined {
  if (pid === undefined || !tree?.has(pid)) return undefined;
  const result = [pid];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index++) {
    for (const child of tree.get(result[index]) ?? []) {
      // Each PID has one parent. Reaching it twice means a cyclic snapshot.
      if (seen.has(child) || seen.size >= tree.size) return undefined;
      seen.add(child);
      result.push(child);
    }
  }
  return result;
}

function terminalTitle(
  agent: AgentRow["tmuxAgent"],
  cwd: string,
  paneTitle?: string,
  name?: string,
): string {
  if (agent !== "pi") {
    const title = meaningfulTitle(
      plain(paneTitle || "")
        .replace(/^[✳✻✽✢⏺●○◐◑◒◓\s]+/u, "")
        .replace(/^(?:claude(?: code)?|(?:openai )?codex)\s*[-·:|]\s*/i, ""),
    );
    if (
      title &&
      !/^(?:claude(?: code)?|(?:openai )?codex|.*claude agents|.*awaiting input.*)$/i.test(
        title,
      )
    )
      return title;
    const label = meaningfulTitle(name);
    if (label && label !== "job") return label;
  }
  return plain(`${sources[agent ?? "pi"]} in ${basename(cwd) || cwd}`, 160);
}

export function tmuxCommand(target: TmuxTarget): string {
  if (!isTmuxTarget(target)) throw new Error("Invalid local tmux target.");
  return `tmux -S ${shellQuote(target.socket)} attach-session -t ${shellQuote(target.session)}`;
}

export function localTmuxRows(
  output: string,
  owners: Presence[],
  processes?: string,
): AgentRow[] {
  const rows: AgentRow[] = [];
  const tree = processTree(processes);
  for (const line of output.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 8 && fields.length !== 9) continue;
    const [socket, session, pane, dead, cwd, name, agent, rawPid, title] =
      fields;
    const tmux = { socket, session, pane };
    if (!isTmuxTarget(tmux) || !isAbsolute(cwd) || !["0", "1"].includes(dead))
      continue;
    const tracked = owners.some(
      (owner) => owner.tmux?.socket === socket && owner.tmux.pane === pane,
    );
    const tmuxAgent = ["pi", "claude", "codex"].includes(agent)
      ? (agent as AgentRow["tmuxAgent"])
      : tracked
        ? "pi"
        : undefined;
    if (!tmuxAgent) continue;
    const parsedPid = /^\d+$/.test(rawPid) ? Number(rawPid) : undefined;
    const pid = positivePid(parsedPid) ? parsedPid : undefined;
    rows.push({
      source: "tmux",
      key: `tmux:${socket}:${pane}`,
      live: dead === "0",
      cwd: pathKey(cwd),
      title: terminalTitle(tmuxAgent, cwd, title, name),
      tmuxTitle: plain(title || "", 160),
      preview:
        dead === "1"
          ? "Retained terminal output. The process exited."
          : "Tmux terminal. Native agent status is not available on this row.",
      model: "",
      status: dead === "1" ? "error" : "unknown",
      updated: 0,
      current: false,
      owners: [],
      tmux,
      tmuxName: plain(name, 160),
      tmuxAgent,
      pid,
      tmuxPids: dead === "0" ? descendantPids(pid, tree) : undefined,
      nativeCommand: tmuxCommand(tmux),
      detail: [
        `tmux ${plain(name, 160)} · ${session} · ${pane}`,
        ...(pid === undefined ? [] : [`Pane PID ${pid}`]),
        "Enter opens here · detach to return to Agents · Ctrl+Y copies attach",
      ].join(" · "),
    });
  }
  return rows;
}

/** Use Pi's exact pane identity or Claude's unique live process ancestry. */
export function mergeLocalTmux(rows: AgentRow[]): AgentRow[] {
  const panes = rows.filter(
    (row) => row.source === "tmux" && !row.host && row.tmux,
  );
  // A tracked Pi owner takes precedence over a nested Claude process, even if
  // the pane's launch tag says Claude. Keep Pi's existing ambiguity guard.
  const piPanes = new Set(
    panes.filter((pane) =>
      rows.some(
        (row) =>
          !row.host &&
          row.source === "pi" &&
          row.owners.some(
            (owner) =>
              owner.tmux?.socket === pane.tmux!.socket &&
              owner.tmux.pane === pane.tmux!.pane,
          ),
      ),
    ),
  );
  const matches = new Map<AgentRow, AgentRow[]>();
  const claims = new Map<AgentRow, number>();
  for (const row of rows) {
    // Failed external discovery retains last-seen rows with live=false. A stale
    // PID must never recover attach/close authority from a healthy tmux pane.
    if (
      row.host ||
      row.source !== "claude" ||
      !row.live ||
      row.tmuxAgent ||
      !positivePid(row.pid)
    )
      continue;
    const candidates = panes.filter(
      (pane) =>
        pane.live &&
        !piPanes.has(pane) &&
        pane.tmuxAgent === "claude" &&
        pane.tmuxPids?.includes(row.pid!),
    );
    matches.set(row, candidates);
    for (const pane of candidates)
      claims.set(pane, (claims.get(pane) ?? 0) + 1);
  }
  const used = new Set<string>();
  const enrich = (row: AgentRow, pane: AgentRow): AgentRow => ({
    ...row,
    tmux: pane.tmux,
    tmuxName: pane.tmuxName,
    title:
      row.source === "claude" && row.title === terminalTitle("claude", row.cwd)
        ? pane.title
        : row.title,
    nativeCommand: pane.nativeCommand,
    detail: [row.detail, pane.detail].filter(Boolean).join(" · "),
  });
  const merged = rows.map((row) => {
    if (row.host) return row;
    if (row.source === "claude") {
      const candidates = matches.get(row);
      if (candidates?.length !== 1 || claims.get(candidates[0]) !== 1)
        return row;
      used.add(candidates[0].key);
      return enrich(row, candidates[0]);
    }
    if (row.source !== "pi") return row;
    const pane = panes.find((candidate) =>
      row.owners.some(
        (owner) =>
          owner.tmux?.socket === candidate.tmux!.socket &&
          owner.tmux.pane === candidate.tmux!.pane,
      ),
    );
    if (!pane) return row;
    used.add(pane.key);
    if (row.owners.length !== 1 || !pane.live) return row;
    return enrich(row, pane);
  });
  return merged
    .filter((row) => !used.has(row.key))
    .map((row) =>
      row.source === "tmux" && !row.host && row.tmuxAgent
        ? {
            ...row,
            source: row.tmuxAgent,
            title: terminalTitle(
              row.tmuxAgent,
              row.cwd,
              row.tmuxTitle,
              row.tmuxName,
            ),
          }
        : row,
    );
}

export function createLocalTmuxAdapter(
  presence: () => Presence[],
): SessionAdapter {
  return {
    source: "tmux",
    async list(signal) {
      signal.throwIfAborted();
      const owners = presence();
      const sockets = new Set<string | undefined>([undefined]);
      for (const owner of owners)
        if (owner.tmux) sockets.add(owner.tmux.socket);
      const processes = new Promise<string | undefined>((resolve) => {
        const child = execFile(
          "ps",
          ["-axo", "pid=,ppid="],
          {
            cwd: homedir(),
            signal,
            // Leave room for healthy pane discovery if ps stalls or fails.
            timeout: 1_000,
            killSignal: "SIGKILL",
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout) => {
            if (signal.aborted) child.kill("SIGKILL");
            resolve(error ? undefined : stdout);
          },
        );
      });
      const [outputs, snapshot] = await Promise.all([
        Promise.all(
          [...sockets].map(
            (socket) =>
              new Promise<string>((resolve, reject) => {
                const child = execFile(
                  "tmux",
                  [
                    ...(socket ? ["-S", socket] : []),
                    "list-panes",
                    "-a",
                    "-F",
                    PANE_FORMAT,
                  ],
                  {
                    cwd: homedir(),
                    signal,
                    timeout: DISCOVERY_TIMEOUT_MS,
                    killSignal: "SIGKILL",
                    encoding: "utf8",
                    maxBuffer: 2 * 1024 * 1024,
                  },
                  (error, stdout, stderr) => {
                    if (signal.aborted) child.kill("SIGKILL");
                    if (
                      error &&
                      !signal.aborted &&
                      /no server running|error connecting .*No such file or directory/.test(
                        stderr,
                      )
                    )
                      resolve("");
                    else if (error) reject(error);
                    else resolve(stdout);
                  },
                );
              }),
          ),
        ),
        processes,
      ]);
      signal.throwIfAborted();
      return [
        ...new Map(
          localTmuxRows(outputs.join("\n"), owners, snapshot).map((row) => [
            row.key,
            row,
          ]),
        ).values(),
      ];
    },
  };
}
