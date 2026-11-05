import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildSessionContext,
  parseSessionEntries,
  type RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import { WorkerRpc, type RecordValue } from "./rpc.ts";
import { alive, Store, type Report, type Worker } from "./store.ts";
import { APPROVAL_COMMAND, WORKER_COMMAND } from "../approval/ready.ts";

export function text(message: RecordValue): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .filter((block: RecordValue) => block.type === "text")
        .map((block: RecordValue) => block.text)
        .join("\n")
    : "";
}

export function report(value: unknown): Report | undefined {
  const item = value as Report | undefined;
  if (
    item &&
    ["complete", "blocked"].includes(item.status) &&
    typeof item.summary === "string" &&
    item.summary.length <= 8_000 &&
    Array.isArray(item.evidence) &&
    item.evidence.length <= 20 &&
    item.evidence.every(
      (entry) => typeof entry === "string" && entry.length <= 2_000,
    ) &&
    (item.status !== "complete" || item.evidence.length > 0)
  )
    return item;
  return undefined;
}

type Live = {
  rpc: WorkerRpc;
  dialogs: Map<string, RecordValue>;
  deadlines: Map<string, ReturnType<typeof setTimeout>>;
  error?: string;
  stopping: boolean;
};
type Options = {
  command: string;
  args: string[] | (() => string[]);
  env: NodeJS.ProcessEnv;
  timeout?: number;
  changed(): void;
  event(worker: Worker, kind: "result" | "input" | "control"): void;
};

export class Supervisor {
  private live = new Map<string, Live>();
  private queue = Promise.resolve();
  private closing = false;

  constructor(
    readonly store: Store,
    private options: Options,
  ) {}

  /** All human/model mutations share one queue, including parallel tool calls. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  enable(): void {
    if (this.closing && this.store.claimed)
      throw new Error("Supervisor cleanup has not finished.");
    this.closing = false;
    this.store.acquire();
    this.store.state.enabled = true;
    this.store.save();
  }

  worker(id: string): Worker {
    const worker = this.store.state.workers.find((item) => item.id === id);
    if (!worker)
      throw new Error("Unknown worker. List this supervisor's workers first.");
    return worker;
  }

  snapshot() {
    return this.store.state.workers.map((worker) => ({
      ...worker,
      live: this.live.has(worker.id),
      pendingInput: this.live.get(worker.id)?.dialogs.size || 0,
    }));
  }

  private save(): void {
    this.store.save();
    this.options.changed();
  }

  private async start(worker: Worker): Promise<Live> {
    const current = this.live.get(worker.id);
    if (current) return current;
    if (this.closing || !this.store.state.enabled)
      throw new Error("Enable the supervisor before starting a worker.");
    if (this.live.size >= 2)
      throw new Error(
        "At most two live workers. Stop an idle worker before starting another.",
      );
    if (worker.pid && alive(worker.pid))
      throw new Error(
        `Worker PID ${worker.pid} may still own this conversation. Refusing a second writer.`,
      );
    if (worker.sessionId) {
      if (!existsSync(worker.sessionFile))
        throw new Error(
          "Worker transcript is missing. Refusing to create a replacement conversation.",
        );
      const header = JSON.parse(
        readFileSync(worker.sessionFile, "utf8").split("\n")[0],
      );
      if (
        header.type !== "session" ||
        header.id !== worker.sessionId ||
        header.cwd !== worker.cwd
      )
        throw new Error(
          "Worker transcript identity or project changed. Refusing to resume.",
        );
    } else if (existsSync(worker.sessionFile)) {
      throw new Error(
        "Unacknowledged worker transcript exists. Inspect it before recovering manually.",
      );
    }
    let rpc: WorkerRpc;
    rpc = new WorkerRpc(
      this.options.command,
      [
        ...(typeof this.options.args === "function"
          ? this.options.args()
          : this.options.args),
        "--mode",
        "rpc",
        "--session",
        worker.sessionFile,
        "--session-dir",
        dirname(worker.sessionFile),
        "--name",
        `Worker ${worker.id} · ${worker.name}`,
      ],
      {
        cwd: worker.cwd,
        env: {
          ...this.options.env,
          PI_SUPERVISOR_WORKER: "1",
          PI_SUPERVISOR_CONTRACT: JSON.stringify({
            objective: worker.objective,
            scope: worker.scope,
            acceptance: worker.acceptance,
          }),
        },
      },
      (event) => this.receive(worker, rpc, event),
      (error) => this.failed(worker, rpc, error),
      this.options.timeout,
    );
    const live: Live = {
      rpc,
      dialogs: new Map(),
      deadlines: new Map(),
      stopping: false,
    };
    this.live.set(worker.id, live);
    worker.pid = rpc.pid;
    this.save(); // Record ownership before awaiting readiness or dispatching work.
    try {
      const state = await rpc.request({ type: "get_state" });
      if (
        state?.sessionFile !== worker.sessionFile ||
        typeof state?.sessionId !== "string" ||
        (worker.sessionId && state.sessionId !== worker.sessionId)
      )
        throw new Error(
          "Worker readiness response has the wrong session identity.",
        );
      worker.sessionId = state.sessionId;
      this.save();
      const commands = await rpc.request({ type: "get_commands" });
      if (
        live.error ||
        ![APPROVAL_COMMAND, WORKER_COMMAND].every((name) =>
          commands?.commands?.some(
            (command: RecordValue) =>
              command.name === name && command.source === "extension",
          ),
        )
      )
        throw new Error(
          "Worker readiness failed: bundled approval and delegation guards must both be registered.",
        );
      return live;
    } catch (error) {
      live.stopping = true;
      this.cancelDialogs(live);
      await rpc.stop();
      this.live.delete(worker.id);
      delete worker.pid;
      worker.status = "error";
      worker.result = String(error);
      this.save();
      throw error;
    }
  }

  async launch(
    task: Pick<Worker, "name" | "objective" | "scope" | "acceptance" | "cwd">,
  ): Promise<Worker> {
    this.enable();
    if (this.live.size >= 2)
      throw new Error("At most two live workers. Stop one first.");
    const cwd = realpathSync(task.cwd);
    if (!statSync(cwd).isDirectory())
      throw new Error("Worker project must be a directory.");
    const worker = this.store.add({ ...task, cwd });
    await this.send(
      worker.id,
      "Begin the delegated task. Inspect the current repository state before editing. Follow the task contract and report evidence with worker_report.",
      "supervisor",
    );
    return worker;
  }

  async send(
    id: string,
    message: string,
    owner: Worker["owner"],
  ): Promise<Worker> {
    const worker = this.worker(id);
    if (worker.owner !== owner)
      throw new Error(
        `Worker is controlled by ${worker.owner}. Return control explicitly before sending instructions.`,
      );
    if (
      !message.trim() ||
      message.length > 16_000 ||
      message.trimStart().startsWith("/")
    )
      throw new Error(
        "Send a nonempty plain-text instruction, at most 16000 characters. Worker slash commands are not supported.",
      );
    const live = await this.start(worker);
    if (live.dialogs.size)
      throw new Error(
        "Worker needs human input. Answer or stop it before sending another instruction.",
      );
    // One instruction per settled run. A late settlement must never be labelled
    // as the result of a newer instruction. Explicit stop/take permits interruption.
    if (worker.status === "working")
      throw new Error(
        "Worker is still running. Wait for its result, or stop it before sending a new instruction.",
      );
    delete worker.report;
    delete live.error;
    worker.result = "";
    worker.lastInstruction = message;
    worker.status = "working";
    this.save();
    try {
      const response = await live.rpc.request({
        type: "prompt",
        message,
      });
      if (
        !response ||
        !["started", "queued", "handled"].includes(response.disposition)
      )
        throw new Error(
          "Worker did not acknowledge the instruction. Outcome unknown.",
        );
      if (response.disposition === "handled" && worker.status === "working") {
        worker.status = "needs-review";
        worker.result =
          "Input was handled without a model run. Inspect the conversation.";
        this.save();
        this.options.event(worker, "result");
      }
      return worker;
    } catch (error) {
      // A lost acknowledgement is not proof of rejection. Never resend.
      worker.status = "error";
      worker.result = `${String(error)} No automatic retry was made.`;
      await this.stop(id);
      worker.status = "error";
      this.save();
      throw error;
    }
  }

  private receive(worker: Worker, rpc: WorkerRpc, event: RecordValue): void {
    const live = this.live.get(worker.id);
    if (!live || live.rpc !== rpc || this.closing) return;
    if (event.type === "extension_ui_request") {
      if (
        ["confirm", "select", "input", "editor"].includes(event.method) &&
        typeof event.id === "string"
      ) {
        live.dialogs.set(event.id, event);
        if (
          typeof event.timeout === "number" &&
          Number.isFinite(event.timeout) &&
          event.timeout >= 0
        ) {
          const timer = setTimeout(
            () => {
              live.dialogs.delete(event.id);
              live.deadlines.delete(event.id);
              this.options.changed();
            },
            Math.min(event.timeout, 2_147_483_647),
          );
          timer.unref();
          live.deadlines.set(event.id, timer);
        }
        this.options.changed();
        this.options.event(worker, "input");
      }
      return; // Child UI notifications never replace the parent's widgets/editor.
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      worker.result = text(event.message).slice(-12_000);
      live.error = ["error", "length"].includes(event.message.stopReason)
        ? event.message.errorMessage ||
          `Worker stopped with ${event.message.stopReason}.`
        : undefined;
    }
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "worker_report" &&
      !event.isError
    )
      worker.report = report(event.result?.details);
    if (event.type === "extension_error")
      live.error = `Worker extension failed: ${event.error}`;
    if (event.type !== "agent_settled") return;
    this.cancelDialogs(live);
    worker.status =
      event.aborted || live.stopping
        ? "stopped"
        : live.error
          ? "error"
          : worker.report?.status === "blocked"
            ? "blocked"
            : worker.report?.status === "complete"
              ? "reported"
              : "needs-review";
    if (live.error) worker.result = live.error;
    this.save();
    if (!live.stopping) this.options.event(worker, "result");
  }

  private failed(worker: Worker, rpc: WorkerRpc, error: Error): void {
    const live = this.live.get(worker.id);
    if (!live || live.rpc !== rpc || this.closing || live.stopping) return;
    this.cancelDialogs(live);
    worker.status = "error";
    worker.result = error.message;
    // A broken pipe is not evidence of process death. Retain the live handle/PID.
    if (!rpc.pid) {
      this.live.delete(worker.id);
      delete worker.pid;
    }
    this.save();
    this.options.event(worker, "result");
  }

  dialogs(id: string): RecordValue[] {
    return [...(this.live.get(id)?.dialogs.values() || [])];
  }

  answer(id: string, response: RpcExtensionUIResponse): void {
    const live = this.live.get(id);
    if (!live?.dialogs.delete(response.id))
      throw new Error("Worker input request expired or was cancelled.");
    clearTimeout(live.deadlines.get(response.id));
    live.deadlines.delete(response.id);
    live.rpc.reply(response);
    this.options.changed();
  }

  private cancelDialogs(live: Live): void {
    for (const id of live.dialogs.keys())
      live.rpc.reply({ type: "extension_ui_response", id, cancelled: true });
    live.dialogs.clear();
    for (const timer of live.deadlines.values()) clearTimeout(timer);
    live.deadlines.clear();
  }

  private async interrupt(worker: Worker): Promise<void> {
    const live = this.live.get(worker.id);
    if (!live) return;
    this.cancelDialogs(live);
    try {
      await live.rpc.request({ type: "clear_queue" }, 5_000);
      await live.rpc.request({ type: "abort" }, 5_000);
    } catch (error) {
      await this.stop(worker.id);
      throw new Error(
        `Interrupt was not acknowledged. Worker stopped rather than handing over a running conversation: ${error}`,
      );
    }
    worker.status = "stopped";
    this.save();
  }

  async take(id: string): Promise<void> {
    const worker = this.worker(id);
    worker.owner = "human"; // Block model instructions before awaiting abort.
    this.save();
    await this.interrupt(worker);
    this.options.event(worker, "control");
  }

  async giveBack(id: string): Promise<void> {
    const worker = this.worker(id);
    // The supervisor receives the human's final instruction and latest result.
    await this.interrupt(worker);
    worker.owner = "supervisor";
    this.save();
    this.options.event(worker, "control");
  }

  async stop(id: string): Promise<void> {
    const worker = this.worker(id);
    const live = this.live.get(id);
    if (live) {
      live.stopping = true;
      this.cancelDialogs(live);
      try {
        await live.rpc.request({ type: "clear_queue" }, 2_000);
        await live.rpc.request({ type: "abort" }, 2_000);
      } catch {
        /* EOF/signals below still stop an unresponsive owned process. */
      }
      await live.rpc.stop();
      this.live.delete(id);
      delete worker.pid;
    } else if (worker.pid && alive(worker.pid)) {
      throw new Error(
        `Unowned live PID ${worker.pid}. Refusing to signal it or release ownership.`,
      );
    } else delete worker.pid;
    if (worker.status === "working") worker.status = "stopped";
    this.save();
  }

  async inspect(id: string): Promise<string> {
    const worker = this.worker(id);
    const live = this.live.get(id);
    let messages: RecordValue[] = [];
    if (live) {
      const response = await live.rpc.request({ type: "get_messages" });
      messages = response.messages;
    } else if (existsSync(worker.sessionFile)) {
      if (statSync(worker.sessionFile).size > 32 * 1024 * 1024)
        throw new Error(
          `Transcript exceeds the inspector's 32 MiB limit. Read ${worker.sessionFile} directly.`,
        );
      const entries = parseSessionEntries(
        readFileSync(worker.sessionFile, "utf8"),
      );
      messages = buildSessionContext(
        entries.filter((entry) => entry.type !== "session"),
      ).messages;
    }
    const transcript = messages
      .filter((message) =>
        ["user", "assistant", "toolResult"].includes(message.role),
      )
      .map(
        (message) =>
          `[${message.role}${message.toolName ? ` · ${message.toolName}` : ""}]\n${text(message)}`,
      )
      .join("\n\n");
    return [
      `${worker.name} · ${worker.id} · ${worker.status} · ${worker.owner} control`,
      `Project: ${worker.cwd}`,
      `Objective: ${worker.objective}`,
      `Scope: ${worker.scope}`,
      `Acceptance: ${worker.acceptance}`,
      `Transcript: ${worker.sessionFile}`,
      "Latest 60000 characters. Thinking and tool-call arguments are omitted. Worker reports are unverified claims.",
      transcript.slice(-60_000) ||
        worker.result ||
        "No conversation messages yet.",
    ].join("\n\n");
  }

  async close(disable = false): Promise<void> {
    this.closing = true;
    if (!this.store.claimed) return;
    if (disable) this.store.state.enabled = false;
    const results = await Promise.allSettled(
      this.store.state.workers.map((worker) => this.stop(worker.id)),
    );
    this.save();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.store.release();
  }
}
