import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Report = {
  status: "complete" | "blocked";
  summary: string;
  evidence: string[];
};
export type Worker = {
  id: string;
  name: string;
  objective: string;
  scope: string;
  acceptance: string;
  cwd: string;
  sessionFile: string;
  sessionId?: string;
  pid?: number;
  owner: "supervisor" | "human";
  status:
    | "stopped"
    | "working"
    | "reported"
    | "blocked"
    | "needs-review"
    | "error"
    | "interrupted";
  lastInstruction: string;
  result: string;
  report?: Report;
};

type State = {
  version: 1;
  parent: string;
  enabled: boolean;
  workers: Worker[];
};

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class Store {
  readonly directory: string;
  readonly lease: string;
  readonly file: string;
  state: State;
  private token = randomUUID();
  private owned = false;

  constructor(root: string, parent: string) {
    this.directory = join(
      root,
      createHash("sha256").update(parent).digest("hex"),
    );
    this.file = join(this.directory, "state.json");
    this.lease = join(this.directory, "lease.json");
    this.state = { version: 1, parent, enabled: false, workers: [] };
    this.reload();
  }

  private reload(): void {
    if (existsSync(this.file)) {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        value.version !== 1 ||
        value.parent !== this.state.parent ||
        typeof value.enabled !== "boolean" ||
        !Array.isArray(value.workers) ||
        value.workers.length > 8 ||
        !value.workers.every((worker: Worker) => this.validWorker(worker)) ||
        new Set(value.workers.map((worker: Worker) => worker.id)).size !==
          value.workers.length
      )
        throw new Error(`Invalid supervisor state: ${this.file}`);
      this.state = value;
    }
  }

  private validWorker(worker: Worker): boolean {
    return (
      worker &&
      /^[a-f0-9]{8}$/.test(worker.id) &&
      [
        "name",
        "objective",
        "scope",
        "acceptance",
        "cwd",
        "lastInstruction",
        "result",
      ].every((key) => typeof worker[key as keyof Worker] === "string") &&
      worker.sessionFile === join(this.directory, worker.id, "session.jsonl") &&
      (worker.pid === undefined ||
        (Number.isInteger(worker.pid) && worker.pid > 0)) &&
      (worker.sessionId === undefined ||
        typeof worker.sessionId === "string") &&
      ["supervisor", "human"].includes(worker.owner) &&
      [
        "stopped",
        "working",
        "reported",
        "blocked",
        "needs-review",
        "error",
        "interrupted",
      ].includes(worker.status)
    );
  }

  acquire(): void {
    if (this.owned) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(
        this.lease,
        JSON.stringify({ pid: process.pid, token: this.token }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(
        `Supervisor ownership is already claimed: ${this.lease}. Close the other supervisor. After a crash, verify its PID and every worker PID are gone before removing this lease. It is never reclaimed automatically.`,
      );
    }
    this.owned = true;
    try {
      this.reload(); // Ownership changes invalidate any earlier in-memory snapshot.
    } catch (error) {
      this.release();
      throw error;
    }
    // Only an explicitly resumed instruction can restart an interrupted run.
    for (const worker of this.state.workers) {
      if (worker.status === "working") worker.status = "interrupted";
      if (worker.pid && !alive(worker.pid)) delete worker.pid;
    }
  }

  get claimed(): boolean {
    return this.owned;
  }

  save(): void {
    if (!this.owned) throw new Error("Supervisor does not own this session.");
    const temporary = `${this.file}.${this.token}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  release(): void {
    if (!this.owned) return;
    const lease = JSON.parse(readFileSync(this.lease, "utf8"));
    if (lease.token !== this.token)
      throw new Error("Supervisor ownership changed.");
    unlinkSync(this.lease);
    this.owned = false;
  }

  add(
    task: Pick<Worker, "name" | "objective" | "scope" | "acceptance" | "cwd">,
  ): Worker {
    if (this.state.workers.length >= 8)
      throw new Error(
        "This prototype keeps at most eight workers per supervisor session.",
      );
    let id: string;
    do id = randomUUID().slice(0, 8);
    while (this.state.workers.some((worker) => worker.id === id));
    const directory = join(this.directory, id);
    mkdirSync(directory, { mode: 0o700 });
    const worker: Worker = {
      ...task,
      id,
      sessionFile: join(directory, "session.jsonl"),
      owner: "supervisor",
      status: "stopped",
      lastInstruction: "",
      result: "",
    };
    this.state.workers.push(worker);
    this.save();
    return worker;
  }
}
