import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packagePath } from "../../lib/config.mjs";
import { claimTriage, runClaudeTriage } from "./claude-triage.ts";
import { closedSummary, emptyCounts } from "./state.ts";
import { Store } from "./store.ts";
import { mergeTriage } from "./triage-protocol.ts";
import { canonical, notesDirectory, voiceInstructions } from "./workflow.ts";

// One refresh outside Pi, for a scheduled morning run. Same collector, read
// allowlist, triage lock and merge as /comms refresh. Returns a log line.
export async function refreshOnce(
  agentDir: string,
  signal: AbortSignal,
): Promise<{ line: string; complete: boolean }> {
  const queue = new Store(join(agentDir, "comms"));
  const state = queue.read();
  const instructions = readFileSync(canonical("triage"), "utf8");
  const voice = voiceInstructions();
  const release = claimTriage(queue.directory);
  try {
    const startedAt = new Date().toISOString();
    const results = await runClaudeTriage({
      cwd: notesDirectory(false) || packagePath(),
      runId: randomUUID(),
      startedAt,
      state,
      instructions,
      voice: voice.text,
      signal,
      progress: () => {},
    });
    signal.throwIfAborted();
    let counts = emptyCounts();
    const latest = queue.update((current) => {
      counts = mergeTriage(current, results, startedAt, state);
    });
    const incomplete = results.filter(
      (row) => row.status !== "complete",
    ).length;
    return {
      complete: !incomplete,
      line: [
        voice.warning,
        `Comms refresh finished · ${latest.items.length} retained · ${incomplete} incomplete source/account checks · ${counts.seeded} of ${counts.proposals} reply proposals seeded.`,
        closedSummary(counts),
      ]
        .filter(Boolean)
        .join(" "),
    };
  } finally {
    release();
  }
}
