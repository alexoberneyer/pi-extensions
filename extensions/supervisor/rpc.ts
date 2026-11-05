import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  RpcCommand,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

export type RecordValue = Record<string, any>;

/** The small RPC subset we need, including the UI reply path RpcClient omits. */
export class WorkerRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private failure?: Error;
  private stopping?: Promise<void>;
  private exited = false;
  private exit: Promise<void>;
  private stderr = "";

  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    private onEvent: (event: RecordValue) => void,
    private onFailure: (error: Error) => void,
    private timeout = 30_000,
  ) {
    this.child = spawn(command, args, { ...options, stdio: "pipe" });
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.fail(
          new Error(`Worker exited (${signal || code}). ${this.stderr}`),
        );
        resolve();
      });
      this.child.once("error", (error) => {
        this.exited = true;
        this.fail(error);
        resolve();
      });
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_192);
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > 16 * 1024 * 1024)
            throw new Error("Worker RPC record exceeds 16 MiB.");
          const event = JSON.parse(line);
          if (!event || typeof event.type !== "string")
            throw new Error("Invalid worker RPC record.");
          if (event.type === "response") {
            const request = this.pending.get(event.id);
            if (!request) continue; // Late replies never start a second operation.
            this.pending.delete(event.id);
            if (event.success === true) request.resolve(event.data);
            else
              request.reject(
                new Error(event.error || "Worker command failed."),
              );
          } else this.onEvent(event);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          void this.stop().catch(() => {});
          return;
        }
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        this.fail(new Error("Worker RPC record exceeds 16 MiB."));
        void this.stop().catch(() => {});
      }
    });
  }

  get pid(): number | undefined {
    return this.exited ? undefined : this.child.pid;
  }

  request(command: RpcCommand, timeout = this.timeout): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `supervisor-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${command.type} timed out. Its outcome is unknown; inspect before retrying.`,
          ),
        );
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ ...command, id });
    });
  }

  reply(response: RpcExtensionUIResponse): void {
    if (!this.failure) this.write(response);
  }

  private write(value: unknown): void {
    // write's callback also covers backpressure. Commands are small and bounded,
    // and stdout consumption never waits for a UI or model operation.
    this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) this.fail(error);
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (!this.stopping) this.onFailure(error);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.child.stdin.end();
      for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
        if (signal && !this.exited) this.child.kill(signal);
        if (await this.waitForExit(1_500)) {
          this.fail(new Error("Worker stopped."));
          return;
        }
      }
      throw new Error(
        "Worker termination is unconfirmed. Ownership was retained.",
      );
    })();
    return this.stopping;
  }

  private async waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return result;
  }
}
