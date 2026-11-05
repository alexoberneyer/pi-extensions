import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const APPROVAL_QUERY = "pi-extensions:approval:query";
export const APPROVAL_READY = "pi-extensions:approval:ready";
export const APPROVAL_COMMAND = "pi-extensions-approval-ready-v1";
export const WORKER_COMMAND = "pi-extensions-worker-ready-v1";
export const GUARD_UNAVAILABLE =
  "Bundled approval guard unavailable. Tools are blocked. Repair the installation/configuration and reload.";

export type ApprovalStatus = { version: 1; ready: boolean; planning: boolean };

/** Pi's event bus dispatches synchronous handlers before emit returns. */
export function approvalStatus(pi: ExtensionAPI): ApprovalStatus | undefined {
  const id = randomUUID();
  let status: ApprovalStatus | undefined;
  const off = pi.events.on(APPROVAL_READY, (data: any) => {
    if (
      data?.id === id &&
      data.version === 1 &&
      typeof data.ready === "boolean" &&
      typeof data.planning === "boolean"
    )
      status = { version: 1, ready: data.ready, planning: data.planning };
  });
  try {
    pi.events.emit(APPROVAL_QUERY, { id });
  } finally {
    off();
  }
  return status;
}

export function requireApproval(pi: ExtensionAPI): ApprovalStatus {
  const status = approvalStatus(pi);
  if (!status?.ready) throw new Error(GUARD_UNAVAILABLE);
  return status;
}

/** Keep consumers fail closed even if the bundled module fails to load. */
export async function initializeApproval(pi: ExtensionAPI): Promise<void> {
  pi.on("tool_call", () => {
    if (!approvalStatus(pi)?.ready)
      return { block: true, reason: GUARD_UNAVAILABLE };
  });
  try {
    const { default: approval } = await import("./index.ts");
    approval(pi);
  } catch {
    // Keep the consumer loaded with its fail-closed hook, including restored plans.
  }
  pi.on("session_start", (_event, ctx) => {
    if (!approvalStatus(pi)?.ready && ctx.hasUI)
      ctx.ui.notify(GUARD_UNAVAILABLE, "error");
  });
}
