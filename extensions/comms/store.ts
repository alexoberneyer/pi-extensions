import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emptyState, validateState, type State } from "./state.ts";

export class Store {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, "queue.json");
  }
  private prepare(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error(
        "Comms state directory must be private (0700) and not a symlink.",
      );
  }
  read(): State {
    this.prepare();
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 8 * 1024 * 1024 ||
        stat.mode & 0o077
      )
        throw new Error(
          "Comms queue must be a private regular file under 8 MiB.",
        );
      return validateState(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  update(change: (state: State) => void): State {
    this.prepare();
    const lock = join(this.directory, "write.lock");
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      throw new Error(
        `Comms queue is busy. Retry after the other view finishes. If a writer crashed, inspect ${lock} before removing it.`,
      );
    }
    const temp = join(this.directory, `queue.${process.pid}.tmp`);
    let ownsTemp = false;
    try {
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
      );
      const state = this.read();
      change(state);
      state.revision++;
      validateState(state);
      const data = JSON.stringify(state, null, 2) + "\n";
      if (Buffer.byteLength(data) > 8 * 1024 * 1024)
        throw new Error("Comms queue is full. Nothing was overwritten.");
      const output = openSync(temp, "wx", 0o600);
      ownsTemp = true;
      try {
        writeFileSync(output, data);
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      renameSync(temp, this.file);
      return state;
    } finally {
      closeSync(fd);
      if (ownsTemp)
        try {
          unlinkSync(temp);
        } catch {
          /* Renamed on success. */
        }
      unlinkSync(lock);
    }
  }
}
