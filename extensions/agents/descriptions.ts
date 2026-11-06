import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { plain } from "./state.ts";

const EDGE_BYTES = 256 * 1024;
const JSON_BYTES = 64 * 1024;
const CACHE_LIMIT = 32;

/** An opaque identity is useful for attachment, not as a conversation title. */
export function meaningfulTitle(value: unknown, ids: string[] = []): string {
  if (typeof value !== "string") return "";
  const title = plain(value, 160);
  const lower = title.toLowerCase();
  if (
    !title ||
    /^(?:job-)?[a-f0-9]{8,}$/i.test(title) ||
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(title) ||
    ids.some((id) => {
      const native = id.toLowerCase();
      return (
        lower.split(" ").every((part) => part === native) ||
        (lower.length >= 8 && native.startsWith(lower))
      );
    }) ||
    /^(?:new|untitled)(?: session| conversation| thread)?$/i.test(title)
  )
    return "";
  return title;
}

export interface TranscriptEdges {
  head: unknown[];
  tail: unknown[];
  gap?: boolean;
}

function records(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // Partial writes and oversized records are not display metadata.
    }
  });
}

/** Dashboard-local cache. Reads only bounded regular-file data, never a history scan. */
export class DescriptionReader {
  private cache = new Map<string, { stamp: string; value: unknown }>();

  private async read(
    file: string,
    jsonl: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    let handle;
    try {
      // NONBLOCK avoids hanging on a FIFO. NOFOLLOW rejects a swapped symlink.
      handle = await open(
        file,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      const key = `${jsonl ? "jsonl" : "json"}:${file}`;
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const previous = this.cache.get(key);
      if (previous?.stamp === stamp) return previous.value;
      const read = async (offset: number, bytes: number) => {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle!.read(buffer, 0, bytes, offset);
        signal.throwIfAborted();
        return buffer.subarray(0, bytesRead);
      };
      let value: unknown;
      if (!jsonl) {
        if (stat.size > JSON_BYTES) return undefined;
        value = JSON.parse((await read(0, stat.size)).toString("utf8"));
      } else {
        const head = await read(0, Math.min(stat.size, EDGE_BYTES));
        if (stat.size <= 2 * EDGE_BYTES) {
          // Adjacent windows are one continuous transcript. Reassemble the
          // boundary record before parsing, including split UTF-8 characters.
          const rest =
            stat.size > EDGE_BYTES
              ? await read(EDGE_BYTES, stat.size - EDGE_BYTES)
              : Buffer.alloc(0);
          const text = Buffer.concat([head, rest]).toString("utf8");
          value = {
            head: records(text.slice(0, text.lastIndexOf("\n") + 1)),
            tail: [],
          } satisfies TranscriptEdges;
        } else {
          const tailOffset = stat.size - EDGE_BYTES;
          const tail = (await read(tailOffset, EDGE_BYTES)).toString("utf8");
          const boundary = (await read(tailOffset - 1, 1)).toString("utf8");
          const start = head.toString("utf8");
          value = {
            head: records(start.slice(0, start.lastIndexOf("\n") + 1)),
            tail: records(
              tail.slice(
                boundary === "\n" ? 0 : tail.indexOf("\n") + 1,
                tail.lastIndexOf("\n") + 1,
              ),
            ),
            gap: true,
          } satisfies TranscriptEdges;
        }
      }
      this.cache.delete(key);
      this.cache.set(key, { stamp, value });
      if (this.cache.size > CACHE_LIMIT)
        this.cache.delete(this.cache.keys().next().value!);
      return value;
    } catch {
      // Optional display metadata must not take native discovery/status down.
      signal.throwIfAborted();
      return undefined;
    } finally {
      await handle?.close();
    }
  }

  async json(file: string, signal: AbortSignal): Promise<unknown> {
    return this.read(file, false, signal);
  }

  async jsonl(file: string, signal: AbortSignal): Promise<TranscriptEdges> {
    return (
      ((await this.read(file, true, signal)) as
        | TranscriptEdges
        | undefined) ?? {
        head: [],
        tail: [],
      }
    );
  }
}
