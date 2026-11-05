import { isAbsolute } from "node:path";

export interface TmuxPane {
  socket: string;
  pane: string;
}

export interface TmuxTarget {
  socket: string;
  session: string;
  pane?: string;
}

function safeSocket(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    value.length <= 4_096 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(value)
  );
}

export function isTmuxPane(value: unknown): value is TmuxPane {
  const pane = value as TmuxPane | undefined;
  return (
    !!pane &&
    safeSocket(pane.socket) &&
    typeof pane.pane === "string" &&
    /^%\d+$/.test(pane.pane) &&
    !/\s/.test(pane.pane)
  );
}

export function isTmuxTarget(value: unknown): value is TmuxTarget {
  const target = value as TmuxTarget | undefined;
  return (
    !!target &&
    safeSocket(target.socket) &&
    typeof target.session === "string" &&
    /^\$\d+$/.test(target.session) &&
    !/\s/.test(target.session) &&
    (target.pane === undefined ||
      (typeof target.pane === "string" &&
        /^%\d+$/.test(target.pane) &&
        !/\s/.test(target.pane)))
  );
}

export function tmuxPresence(env = process.env): TmuxPane | undefined {
  // Socket names may contain commas. The final two fields are numeric.
  const socket = env.TMUX?.match(/^(.*),\d+,\d+$/)?.[1];
  const pane = { socket, pane: env.TMUX_PANE };
  return isTmuxPane(pane) ? pane : undefined;
}
