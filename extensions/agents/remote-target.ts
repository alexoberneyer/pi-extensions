import { isTmuxTarget, type TmuxTarget } from "./tmux-target.ts";

export interface RemoteTmuxTarget extends TmuxTarget {
  host: "dev01";
  sshHost: string;
  pane: string;
}

export type AgentTarget = TmuxTarget | RemoteTmuxTarget;

export function isSshHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(value) &&
    !/\s/.test(value)
  );
}

export function isRemoteTmuxTarget(value: unknown): value is RemoteTmuxTarget {
  const target = value as RemoteTmuxTarget | undefined;
  return (
    target?.host === "dev01" &&
    isSshHost(target.sshHost) &&
    isTmuxTarget(value) &&
    typeof value.pane === "string"
  );
}
