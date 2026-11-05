import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export interface ApprovalRecord {
  version: 1;
  timestamp: string;
  toolCallId: string;
  parentToolCallId?: string;
  tool: string;
  phase: "prompt" | "decision";
  reason: string;
  outcome?:
    | "allowed"
    | "denied"
    | "blocked"
    | "error"
    | "explicit-request"
    | "owned-temp-cleanup";
}

/** Only categorical metadata. Never command bodies, arguments, user text or paths. */
export function appendAudit(
  directory: string,
  sessionId: string,
  record: ApprovalRecord,
): void {
  if (!/^[a-zA-Z0-9-]{1,200}$/.test(sessionId))
    throw Error("Invalid approval session ID");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw Error("Unsafe approval log directory");
  chmodSync(directory, 0o700);
  const fd = openSync(
    join(directory, `${sessionId}.jsonl`),
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const file = fstatSync(fd);
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw Error("Unsafe approval log file");
    fchmodSync(fd, 0o600);
    if (file.size) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, file.size - 1) !== 1 || tail[0] !== 10)
        throw Error(
          "Incomplete approval audit tail. Repair the log before retrying.",
        );
    }
    const line = `${JSON.stringify(record)}\n`;
    if (writeSync(fd, line) !== Buffer.byteLength(line))
      throw Error("Incomplete approval audit write");
  } finally {
    closeSync(fd);
  }
}

export function recordApproval(
  ctx: ExtensionContext,
  event: ToolCallEvent,
  decision: Pick<ApprovalRecord, "phase" | "reason" | "outcome">,
  inMemory: (record: ApprovalRecord) => void,
): void {
  const record: ApprovalRecord = {
    version: 1,
    timestamp: new Date().toISOString(),
    toolCallId: event.toolCallId,
    ...(event.parentToolCallId
      ? { parentToolCallId: event.parentToolCallId }
      : {}),
    tool: event.toolName,
    ...decision,
  };
  // SDK/in-memory sessions explicitly opt out of durable session storage.
  if (!ctx.sessionManager.getSessionFile()) {
    inMemory(record);
    return;
  }
  appendAudit(
    join(getAgentDir(), "approval-log"),
    ctx.sessionManager.getSessionId(),
    record,
  );
}
