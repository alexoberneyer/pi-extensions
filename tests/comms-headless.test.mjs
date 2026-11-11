import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Synthetic data and a fake claude only. Never runs install: that would load
// a real launchd job.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "bin", "comms-refresh.mjs");
const account = "work@example.invalid";
const results = ["mail", "teams", "calendar", "notion"].map((source) => ({
  source,
  account,
  status: "complete",
  detail: "Fixture all pages",
  items:
    source === "mail"
      ? [
          {
            sourceId: "fixture-mail-1",
            sourceUpdatedAt: "2026-10-19T08:00:00.000Z",
            title: "Send the signed form",
            person: "Fixture sender",
            summary: "Please send the signed form.",
            suggestion: "Send the form",
            priority: 2,
            dueAt: "2026-10-22T09:30:00+02:00",
          },
        ]
      : [],
}));

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "comms-headless-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const agent = join(dir, "agent");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const runId=input.match(/Run ID: ([^.\\s]+)/)[1];
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,permission_denials:[],structured_output:{runId,results:${JSON.stringify(results)}}}));
});
`,
    { mode: 0o700 },
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PI_PACKAGE_DIR: process.env.PI_TEST_PACKAGE_DIR,
        PI_CODING_AGENT_DIR: agent,
      },
    });
  return { agent, run };
}

test("one headless refresh merges into the same queue Pi reads", (t) => {
  const { agent, run } = setup(t);
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.match(
    done.stdout,
    /Comms refresh finished · 1 retained · 0 incomplete/,
  );
  const queue = JSON.parse(
    readFileSync(join(agent, "comms", "queue.json"), "utf8"),
  );
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].dueAt, "2026-10-22T07:30:00.000Z");
  assert.equal(queue.coverage.length, 4);
});

test("a held triage lock stops the run before Claude starts", (t) => {
  const { agent, run } = setup(t);
  mkdirSync(join(agent, "comms"), { recursive: true, mode: 0o700 });
  writeFileSync(join(agent, "comms", "triage.lock"), "{}", { mode: 0o600 });
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Another Comms refresh may be running/);
});

test("bad arguments fail before anything is written", (t) => {
  const { run } = setup(t);
  assert.match(run("install", "7am").stderr, /HH:MM/);
  assert.match(run("schedule").stderr, /Usage/);
});
