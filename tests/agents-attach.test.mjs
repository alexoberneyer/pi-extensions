import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const tuiPath = require.resolve("@earendil-works/pi-tui");
const source = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/agents",
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
    "@earendil-works/pi-tui": tuiPath,
  },
});
const { attachTmux } = await jiti.import(join(source, "attach.ts"));
const {
  createLocalTmuxAdapter,
  localTmuxRows,
  mergeLocalTmux,
  PANE_FORMAT,
  tmuxCommand,
} = await jiti.import(join(source, "local-tmux.ts"));
const { claudeRows, createClaudeAdapter } = await jiti.import(
  join(source, "claude.ts"),
);
const { isTmuxTarget, tmuxPresence } = await jiti.import(
  join(source, "tmux-target.ts"),
);
const { Dashboard } = await jiti.import(join(source, "dashboard.ts"));
const { ExternalSessions } = await jiti.import(join(source, "external.ts"));
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const { getKeybindings } = await import(pathToFileURL(tuiPath));
const tick = () => new Promise((done) => setImmediate(done));
const target = { socket: "/tmp/agents-test.sock", session: "$42", pane: "%7" };
const native = {
  source: "pi",
  key: "pi-native",
  cwd: "/project",
  title: "Native Pi",
  preview: "Working on it",
  status: "working",
  updated: 1,
  live: true,
  current: false,
  owners: [{ tmux: { socket: target.socket, pane: target.pane } }],
  sessionFile: "/project/session.jsonl",
};
const paneLine = (agent = "pi", dead = "0", overrides = {}) => {
  const pane = {
    ...target,
    cwd: "/project",
    name: "job",
    pid: "73212",
    ...overrides,
  };
  return (
    [
      pane.socket,
      pane.session,
      pane.pane,
      dead,
      pane.cwd,
      pane.name,
      agent,
      pane.pid,
    ].join("\t") + "\n"
  );
};
const processes = " 73212 1\n 73238 73212\n";
const nativeClaude = (overrides = {}) =>
  claudeRows([
    {
      sessionId: "native-claude",
      cwd: "/project",
      pid: 73238,
      name: "project-65",
      status: "busy",
      statusUpdatedAt: 1234,
      waitingFor: "Native preview",
      ...overrides,
    },
  ])[0];
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-agents-attach-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function env(t, key, value) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
function view(opener, rows = [{ ...native, tmux: target }], launcher) {
  const calls = { closed: 0, refresh: 0 };
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const dashboard = new Dashboard(
    tui,
    getThemeByName("dark"),
    getKeybindings(),
    "/project",
    () => calls.closed++,
    () => calls.refresh++,
    () => {},
    undefined,
    launcher,
    true,
    opener,
  );
  dashboard.setData(rows);
  dashboard.focused = true;
  return { dashboard, calls };
}

test("tmux identities reject shell syntax, control characters and relative sockets", () => {
  assert.ok(isTmuxTarget(target));
  for (const change of [
    { socket: "relative" },
    { socket: "/tmp/bad\npath" },
    { session: "job;evil" },
    { session: "$42;evil" },
    { pane: "%7\x1b" },
  ])
    assert.equal(isTmuxTarget({ ...target, ...change }), false);
  assert.deepEqual(
    tmuxPresence({ TMUX: "/tmp/with,comma.sock,123,4", TMUX_PANE: "%7" }),
    { socket: "/tmp/with,comma.sock", pane: "%7" },
  );
  assert.equal(
    tmuxPresence({ TMUX: "relative,123,4", TMUX_PANE: "%7" }),
    undefined,
  );
  assert.equal(
    tmuxPresence({ TMUX: "/tmp/s,123,4", TMUX_PANE: "bad" }),
    undefined,
  );
  assert.match(
    tmuxCommand({ ...target, socket: "/tmp/O'Brien.sock" }),
    /O'\\''Brien/,
  );
});

test("local tmux discovers only tagged jobs or tracked Pi panes and never invents Ready status", () => {
  assert.deepEqual(localTmuxRows(paneLine(""), []), []);
  for (const agent of ["pi", "claude", "codex"]) {
    const [row] = localTmuxRows(paneLine(agent), []);
    assert.equal(row.source, "tmux");
    assert.equal(row.tmuxAgent, agent);
    assert.equal(row.tmuxName, "job");
    assert.equal(row.pid, 73212);
    assert.equal(
      row.tmuxPids,
      undefined,
      "pane PID alone is not process evidence",
    );
    assert.equal(row.status, "unknown");
    assert.equal(row.updated, 0);
    assert.deepEqual(row.tmux, target);
  }
  assert.equal(
    localTmuxRows(paneLine("", "1"), native.owners)[0].status,
    "error",
  );
  assert.deepEqual(
    localTmuxRows(paneLine("pi").replace("$42", "unsafe"), []),
    [],
  );
});

test("native Pi gets a verified attachment without a duplicate tmux row or weaker ownership guard", () => {
  const panes = localTmuxRows(paneLine(""), native.owners);
  const merged = mergeLocalTmux([native, ...panes]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].tmux, target);
  assert.equal(merged[0].status, "working");
  assert.equal(merged[0].preview, "Working on it");
  const duplicate = mergeLocalTmux([
    { ...native, owners: [...native.owners, ...native.owners] },
    ...panes,
  ]);
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].tmux, undefined);
  assert.equal(
    mergeLocalTmux([native, ...localTmuxRows(paneLine("pi", "1"), [])])[0].tmux,
    undefined,
  );
});

test("tracked Pi ownership prevents a nested Claude process claiming the same pane", () => {
  const claude = nativeClaude();
  const panes = localTmuxRows(paneLine("claude"), native.owners, processes);
  for (const owners of [native.owners, [...native.owners, ...native.owners]]) {
    const merged = mergeLocalTmux([{ ...native, owners }, claude, ...panes]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].status, native.status);
    assert.deepEqual(merged[0].tmux, owners.length === 1 ? target : undefined);
    assert.equal(merged[1], claude);
    assert.equal(merged[1].tmux, undefined);
  }
  const remote = { ...native, host: "dev01" };
  const merged = mergeLocalTmux([remote, claude, ...panes]);
  assert.equal(merged[0], remote);
  assert.deepEqual(
    merged[1].tmux,
    target,
    "remote Pi cannot claim a local pane",
  );
});

test("Claude's observed direct child PID maps job-4abb1f45 to native project-65, not same-project neighbours", () => {
  const claude = nativeClaude({ cwd: "/Users/fixture/work/project" });
  const others = [
    nativeClaude({ sessionId: "other-a", pid: 90000, cwd: claude.cwd }),
    nativeClaude({ sessionId: "other-b", pid: 90001, cwd: claude.cwd }),
  ];
  const panes = localTmuxRows(
    paneLine("claude", "0", { cwd: claude.cwd, name: "job-4abb1f45" }),
    [],
    processes + "90000 1\n90001 1\n",
  );
  assert.deepEqual(panes[0].tmuxPids, [73212, 73238]);
  const merged = mergeLocalTmux([claude, ...others, ...panes]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0].tmux, target);
  assert.equal(merged[0].tmuxName, "job-4abb1f45");
  assert.equal(merged[0].nativeCommand, tmuxCommand(target));
  for (const field of ["title", "status", "updated", "preview", "pid", "live"])
    assert.equal(merged[0][field], claude[field]);
  assert.match(merged[0].detail, /job-4abb1f45.*\$42.*%7/);
  for (let i = 0; i < others.length; i++)
    assert.equal(
      merged[i + 1],
      others[i],
      "cwd and title never prove ownership",
    );
});

test("Claude ownership includes the pane process itself and wrapper descendants", () => {
  for (const snapshot of [
    "73212 1\n",
    "73238 74000\n74000 73900\n73900 73212\n73212 1\n",
  ]) {
    const claude = nativeClaude({
      pid: snapshot.includes("73238") ? 73238 : 73212,
    });
    const merged = mergeLocalTmux([
      claude,
      ...localTmuxRows(paneLine("claude"), [], snapshot),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].tmux, target);
  }
});

test("nested Claude sessions, duplicate native PID claims and overlapping pane trees are ambiguous", () => {
  const claude = nativeClaude();
  const panes = localTmuxRows(
    paneLine("claude"),
    [],
    processes + "74000 73238\n",
  );
  for (const pid of [73238, 74000]) {
    const other = nativeClaude({ sessionId: "nested", pid });
    const merged = mergeLocalTmux([claude, other, ...panes]);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].tmux, undefined);
    assert.equal(merged[1].tmux, undefined);
    assert.equal(merged[2].source, "claude");
    assert.equal(merged[2].status, "unknown");
  }
  const overlapping = localTmuxRows(
    paneLine("claude") + paneLine("claude", "0", { pane: "%8", pid: "73238" }),
    [],
    processes,
  );
  const merged = mergeLocalTmux([claude, ...overlapping]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].tmux, undefined);
});

test("Claude requires a live local native row and a live declared Claude pane, never Codex thread guesses", () => {
  const claude = nativeClaude();
  const panes = localTmuxRows(paneLine("claude"), [], processes);
  for (const row of [
    { ...claude, host: "dev01" },
    { ...claude, live: false },
    { ...claude, pid: undefined },
    { ...claude, source: "codex" },
  ]) {
    const merged = mergeLocalTmux([row, ...panes]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0], row);
    assert.equal(merged[0].tmux, undefined);
  }
  for (const agent of ["pi", "codex"])
    assert.equal(
      mergeLocalTmux([
        claude,
        ...localTmuxRows(paneLine(agent), [], processes),
      ])[0].tmux,
      undefined,
    );
  const remotePane = { ...panes[0], host: "dev01" };
  assert.deepEqual(mergeLocalTmux([claude, remotePane]), [claude, remotePane]);
  const dead = localTmuxRows(paneLine("claude", "1"), [], processes);
  assert.equal(dead[0].tmuxPids, undefined);
  const retained = mergeLocalTmux([claude, ...dead]);
  assert.equal(retained.length, 2);
  assert.equal(retained[0], claude);
  assert.equal(retained[1].status, "error");
  assert.equal(retained[1].live, false);
  assert.deepEqual(
    retained[1].tmux,
    target,
    "retained output remains attachable",
  );
});

test("unmatched panes use actual agent sources and project titles, keeping job identities in details", () => {
  for (const agent of ["pi", "claude", "codex"]) {
    const [pane] = localTmuxRows(
      paneLine(agent, "0", { cwd: "/work/project", name: "job-4abb1f45" }),
      [],
    );
    const [row] = mergeLocalTmux([
      { ...pane, title: "Old raw task or job hash" },
    ]);
    assert.equal(row.source, agent);
    assert.equal(
      row.title,
      `${agent === "pi" ? "Pi" : agent === "claude" ? "Claude" : "Codex"} in project`,
    );
    assert.equal(row.tmuxName, "job-4abb1f45");
    assert.match(row.detail, /job-4abb1f45.*\$42.*%7/);
    assert.doesNotMatch(row.title, /job-|raw task/);
    assert.equal(row.status, "unknown");
    assert.deepEqual(row.tmux, target);
  }
});

test("invalid pane PIDs and unavailable, malformed, cyclic or oversized process snapshots cannot authorize mapping", () => {
  const claude = nativeClaude();
  for (const pid of ["", "0", "-1", "3.5", "7e4", "73212x", "9007199254740992"])
    assert.equal(
      localTmuxRows(paneLine("claude", "0", { pid }), [], processes)[0].pid,
      undefined,
    );
  for (const snapshot of [
    undefined,
    "",
    "73238 73212\n", // The pane root was not observed.
    "73212 1\n73238 73212 secret-argv\n",
    "73212 1\n73238 73212\n73238 2\n",
    "73212 73238\n73238 73212\n",
    "73212 73212\n73238 73212\n",
    Array.from({ length: 100_001 }, (_, i) => `${i + 1} 0`).join("\n"),
  ]) {
    const [pane] = localTmuxRows(paneLine("claude"), [], snapshot);
    assert.equal(pane.tmuxPids, undefined);
    const merged = mergeLocalTmux([claude, pane]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].tmux, undefined);
    assert.deepEqual(merged[1].tmux, target);
    assert.equal(merged[1].status, "unknown");
  }
  const deep =
    "73212 1\n" +
    Array.from(
      { length: 5000 },
      (_, i) => `${100000 + i} ${i ? 99999 + i : 73212}`,
    ).join("\n");
  assert.equal(
    localTmuxRows(paneLine("claude"), [], deep)[0].tmuxPids.length,
    5001,
  );
});

test("Pi exact socket/pane mapping remains independent of process discovery and rejects mismatches", () => {
  for (const change of [{ socket: "/tmp/other.sock" }, { pane: "%8" }]) {
    const panes = localTmuxRows(paneLine("pi", "0", change), [], processes);
    const merged = mergeLocalTmux([native, ...panes]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].tmux, undefined);
  }
  const [merged] = mergeLocalTmux([
    native,
    ...localTmuxRows(paneLine(""), native.owners),
  ]);
  assert.deepEqual(merged.tmux, target);
});

test("failed Claude discovery cannot use a stale PID to recover attach or close authority", async (t) => {
  let failed = false;
  const sessions = new ExternalSessions(
    [
      {
        source: "claude",
        list: async () => {
          if (failed) throw Error("Unavailable");
          return [nativeClaude()];
        },
      },
    ],
    () => {},
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  const panes = localTmuxRows(paneLine("claude"), [], processes);
  assert.deepEqual(
    mergeLocalTmux([...sessions.rows, ...panes])[0].tmux,
    target,
  );
  failed = true;
  sessions.refresh();
  await tick();
  assert.equal(sessions.rows[0].live, false);
  const stale = mergeLocalTmux([...sessions.rows, ...panes]);
  assert.equal(stale.length, 2);
  assert.equal(stale[0].tmux, undefined);
  assert.equal(stale[0].nativeCommand, undefined);
  failed = false;
  sessions.refresh();
  await tick();
  assert.deepEqual(
    mergeLocalTmux([...sessions.rows, ...panes])[0].tmux,
    target,
  );
});

test("tagged Pi fallback remains attachable without pretending it has native presence", async () => {
  const opened = [];
  const rows = mergeLocalTmux(localTmuxRows(paneLine("pi"), []));
  assert.equal(rows[0].source, "pi");
  assert.equal(rows[0].status, "unknown");
  assert.deepEqual(rows[0].owners, []);
  const { dashboard, calls } = view(
    async (target) => opened.push(target),
    rows,
  );
  assert.match(dashboard.render(140).join("\n"), /Enter: Attach local tmux/);
  dashboard.handleInput("\r");
  await tick();
  assert.deepEqual(opened, [target]);
  assert.equal(calls.closed, 0);
});

test("Enter attaches rather than switching sessions and restores search, filters and selection", async () => {
  let finish;
  const opened = [];
  const { dashboard, calls } = view((value, signal) => {
    opened.push({ value, signal });
    return new Promise((done) => {
      finish = done;
    });
  });
  dashboard.handleInput("Native");
  dashboard.handleInput("\t");
  dashboard.handleInput("\t"); // Working
  const before = dashboard.render(140).slice(0, 4);
  dashboard.handleInput("\r");
  dashboard.handleInput("\r");
  await tick();
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].value, target);
  assert.equal(calls.closed, 0);
  finish();
  await tick();
  assert.equal(calls.refresh, 1);
  assert.equal(dashboard.selectedRow().key, native.key);
  assert.deepEqual(dashboard.render(140).slice(0, 4), before);
  assert.match(dashboard.render(140).join("\n"), /Returned to Agents/);
});

test("new local launch opens its exact target automatically and closes the pending form without a success screen", async () => {
  const launched = { ...target, session: "$99", pane: "%9" };
  const opened = [],
    requests = [];
  let finish;
  const { dashboard, calls } = view(
    (value) => {
      opened.push(value);
      return new Promise((done) => {
        finish = done;
      });
    },
    [native],
    async (request) => {
      requests.push(request);
      return {
        message: "HIDDEN-LAUNCH-SUCCESS",
        attachCommand: tmuxCommand(launched),
        tmux: launched,
      };
    },
  );
  dashboard.handleInput("\x0e");
  dashboard.handleInput("\r");
  await tick();
  assert.deepEqual(opened, [launched]);
  assert.equal(requests[0].host, "local");
  assert.deepEqual(Object.keys(requests[0]).sort(), [
    "agent",
    "cwd",
    "host",
    "name",
  ]);
  assert.equal(calls.refresh, 1);
  assert.match(dashboard.render(140).join("\n"), /Opening agent/);
  assert.doesNotMatch(
    dashboard.render(140).join("\n"),
    /Enter opens|HIDDEN-LAUNCH-SUCCESS/,
  );
  dashboard.handleInput("\r");
  await tick();
  assert.equal(opened.length, 1);
  assert.equal(requests.length, 1);
  finish("switched");
  await tick();
  assert.doesNotMatch(
    dashboard.render(140).join("\n"),
    /New agent|HIDDEN-LAUNCH-SUCCESS/,
  );
  assert.equal(calls.refresh, 2);
  assert.equal(calls.closed, 0);
  assert.equal(dashboard.focused, true);
  assert.equal(dashboard.selectedRow().key, native.key);
});

test("failed opening stays in the dashboard, and disposal cancels only the attach helper", async () => {
  const failure = view(async () => {
    throw Error("Agent exited");
  });
  failure.dashboard.handleInput("\r");
  await tick();
  assert.match(
    failure.dashboard.render(140).join("\n"),
    /Cannot open agent.*Agent exited/,
  );
  assert.equal(failure.calls.closed, 0);
  let signal, finish;
  const pending = view((_target, s) => {
    signal = s;
    return new Promise((done) => {
      finish = done;
    });
  });
  pending.dashboard.handleInput("\r");
  await tick();
  pending.dashboard.dispose();
  assert.equal(signal.aborted, true);
  finish();
  await tick();
  assert.equal(pending.calls.refresh, 0);
});

test("current Pi, duplicate owners and remote rows cannot enter the local attach path", async () => {
  let opens = 0;
  for (const row of [
    { ...native, tmux: target, current: true },
    { ...native, tmux: target, owners: [...native.owners, ...native.owners] },
    { ...native, tmux: target, host: "dev01" },
  ]) {
    const { dashboard } = view(async () => {
      opens++;
    }, [row]);
    dashboard.handleInput("\r");
    await tick();
  }
  assert.equal(opens, 0);
});

test("failed tmux discovery disables stale direct attachment until recovery", async (t) => {
  let failed = false;
  const sessions = new ExternalSessions(
    [
      {
        source: "tmux",
        list: async () => {
          if (failed) throw Error("Unavailable");
          return localTmuxRows(paneLine(), []);
        },
      },
    ],
    () => {},
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  assert.deepEqual(sessions.rows[0].tmux, target);
  failed = true;
  sessions.refresh();
  await tick();
  assert.equal(sessions.rows[0].tmux, undefined);
  assert.equal(sessions.rows[0].nativeCommand, undefined);
  assert.equal(sessions.rows[0].status, "unknown");
  failed = false;
  sessions.refresh();
  await tick();
  assert.deepEqual(sessions.rows[0].tmux, target);
});

function tmuxFixture(t, mode = "ok", processMode = "ok", local = {}) {
  const root = temporary(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  writeFileSync(
    join(bin, "tmux"),
    `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
const local = ${JSON.stringify(local)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args.includes('list-panes')) console.log(${JSON.stringify(paneLine())});
else if (args.includes('display-message')) {
  const source = args[1] === '/tmp/outer';
  console.log(source
    ? [local.sourcePid || '123', '$0', '@0', local.sourcePane || '%0', local.sourceTTY || '/dev/stdin', local.linked || '0'].join('\\t')
    : [local.sameServer ? '123' : '456', ${JSON.stringify(mode === "moved" ? "$43" : "$42")}, '@2', '%7', '/dev/stdin', '0'].join('\\t'));
} else if (args.includes('list-clients')) console.log(local.clients ?? '/dev/ttys007\\t987\\t$0\\t%0\\t0');
else if (args.includes('if-shell')) {
  if (args[1] === '/tmp/outer') console.log(local.queueOutput ?? (local.sameServer ? 'switched' : 'window'));
  else setTimeout(() => process.exit(${mode === "fail" ? 3 : 0}), 150);
} else process.exit(9);`,
    { mode: 0o700 },
  );
  const psLog = join(root, "ps-calls.jsonl");
  writeFileSync(
    join(bin, "ps"),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(psLog)}, JSON.stringify(process.argv.slice(2))+'\\n');
if (${JSON.stringify(processMode)} === 'fail') process.exit(1);
if (${JSON.stringify(processMode)} === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else console.log(${JSON.stringify(processes)});`,
    { mode: 0o700 },
  );
  env(t, "PATH", bin);
  env(t, "TMUX", undefined);
  env(t, "TMUX_PANE", undefined);
  return {
    root,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    processCalls: () =>
      readFileSync(psLog, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("local discovery is read-only, deduplicates socket probes and cancels cleanly", async (t) => {
  const fixture = tmuxFixture(t);
  const adapter = createLocalTmuxAdapter(() => [
    ...native.owners,
    ...native.owners,
  ]);
  const rows = await adapter.list(new AbortController().signal);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tmux, target);
  assert.deepEqual(rows[0].tmuxPids, [73212, 73238]);
  assert.ok(PANE_FORMAT.includes("#{pane_pid}"));
  assert.equal(
    fixture.calls().length,
    2,
    "one default and one unique owned socket",
  );
  assert.deepEqual(fixture.processCalls(), [["-axo", "pid=,ppid="]]);
  assert.ok(
    fixture
      .calls()
      .every(
        (args) =>
          args.includes("list-panes") && !args.includes("attach-session"),
      ),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(adapter.list(abort.signal));
  assert.equal(
    fixture.calls().length,
    2,
    "pre-cancelled discovery must not spawn",
  );
  assert.equal(fixture.processCalls().length, 1);
});

for (const mode of ["fail", "hang"])
  test(
    `process snapshot ${mode} retains healthy attachable panes with no guessed identity`,
    { timeout: 5000 },
    async (t) => {
      const fixture = tmuxFixture(t, "ok", mode);
      const rows = await createLocalTmuxAdapter(() => []).list(
        AbortSignal.timeout(3000),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "unknown");
      assert.equal(rows[0].tmuxPids, undefined);
      assert.deepEqual(rows[0].tmux, target);
      assert.equal(rows[0].nativeCommand, tmuxCommand(target));
      assert.deepEqual(fixture.processCalls(), [["-axo", "pid=,ppid="]]);
    },
  );

test("cancellation while reading processes rejects discovery, never commits a partial snapshot", async (t) => {
  tmuxFixture(t, "ok", "hang");
  await assert.rejects(
    createLocalTmuxAdapter(() => []).list(AbortSignal.timeout(200)),
    /abort/i,
  );
});

test("source timeout discards pending process mapping and clears stale pane authority", async (t) => {
  tmuxFixture(t, "ok", "hang");
  const adapter = createLocalTmuxAdapter(() => []);
  let pending = false;
  const sessions = new ExternalSessions(
    [
      {
        ...adapter,
        timeoutMs: 100,
        list: async (signal) =>
          pending
            ? adapter.list(signal)
            : localTmuxRows(paneLine(), [], processes),
      },
    ],
    () => {},
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  assert.deepEqual(sessions.rows[0].tmux, target);
  pending = true;
  sessions.refresh();
  for (let i = 0; i < 100 && !sessions.summary.includes("unavailable"); i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.match(sessions.summary, /unavailable/);
  assert.equal(sessions.rows[0].live, false);
  assert.equal(sessions.rows[0].tmux, undefined);
  assert.equal(sessions.rows[0].nativeCommand, undefined);
});

function tty(t) {
  for (const stream of [process.stdin, process.stdout]) {
    const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    t.after(() => {
      if (original) Object.defineProperty(stream, "isTTY", original);
      else delete stream.isTTY;
    });
  }
  const events = [];
  return {
    events,
    tui: {
      stop: () => events.push("stop"),
      start: () => events.push("start"),
      requestRender: (force) => events.push(force),
    },
  };
}

test("local opening rejects remote identity fields before probes or terminal handoff", async (t) => {
  const fixture = tmuxFixture(t);
  const { tui, events } = tty(t);
  for (const change of [
    { host: "dev01" },
    { sshHost: "build-box" },
    { host: "dev01", sshHost: "build-box" },
  ])
    await assert.rejects(
      attachTmux(tui, { ...target, ...change }, new AbortController().signal),
      /Invalid local tmux target/,
    );
  assert.deepEqual(fixture.calls(), []);
  assert.deepEqual(events, []);
});

for (const mode of ["ok", "fail", "moved"])
  test(`terminal handoff ${mode} restores the renderer and never blocks the parent event loop`, async (t) => {
    const fixture = tmuxFixture(t, mode);
    const { tui, events } = tty(t);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    t.after(() => clearInterval(timer));
    const result = attachTmux(tui, target, new AbortController().signal);
    if (mode === "ok") await result;
    else
      await assert.rejects(
        result,
        mode === "moved" ? /moved or exited/ : /exited with code 3/,
      );
    assert.deepEqual(events, mode === "moved" ? [] : ["stop", "start", true]);
    if (mode !== "moved") assert.ok(ticks > 5, "attach must not use spawnSync");
    assert.ok(
      fixture
        .calls()
        .every(
          (args) =>
            !args.some((arg) =>
              /kill-session|kill-server|new-session/.test(arg),
            ),
        ),
    );
  });

test("same-server opening switches only the verified client to an exact pane without stopping Pi", async (t) => {
  const fixture = tmuxFixture(t, "ok", "ok", { sameServer: true });
  const { tui, events } = tty(t);
  env(t, "TMUX", "/tmp/outer,123,0");
  env(t, "TMUX_PANE", "%0");
  assert.equal(
    await attachTmux(tui, target, new AbortController().signal),
    "switched",
  );
  assert.deepEqual(events, []);
  const calls = fixture.calls();
  assert.deepEqual(
    calls.map((args) => args[2]),
    ["display-message", "display-message", "list-clients", "if-shell"],
  );
  const queue = calls.at(-1);
  assert.deepEqual(queue.slice(0, 6), [
    "-S",
    "/tmp/outer",
    "if-shell",
    "-F",
    "-t",
    "%0",
  ]);
  assert.match(queue[6], /client_name.*client_pid.*client_control_mode/);
  assert.match(queue[6], /session_attached_list.*window_active.*pane_active/);
  assert.match(queue[6], /\/dev\/ttys007/);
  assert.match(queue[6], /987:0:0/);
  assert.match(queue[7], /switch-client/);
  assert.match(queue[7], /\$42:@2\.%7/);
  assert.match(queue[7], /123 \$42 @2 %7/);
  assert.doesNotMatch(
    queue.join(" "),
    /attach-session|new-window|detach-client/,
  );
});

test("different-server opening uses a sibling window with a guarded attach and clean nesting environment", async (t) => {
  const fixture = tmuxFixture(t);
  const { tui, events } = tty(t);
  env(t, "TMUX", "/tmp/outer,123,0");
  env(t, "TMUX_PANE", "%0");
  assert.equal(
    await attachTmux(tui, target, new AbortController().signal),
    "window",
  );
  assert.deepEqual(events, []);
  const queue = fixture.calls().at(-1);
  assert.equal(queue[1], "/tmp/outer");
  assert.match(queue[7], /new-window/);
  assert.match(queue[7], /env.*-u.*TMUX.*-u.*TMUX_PANE.*tmux/);
  assert.match(queue[7], /agents-test\.sock/);
  assert.match(queue[7], /if-shell.*456 \$42 @2 %7.*attach-session/);
  assert.doesNotMatch(queue[7], /switch-client|ssh/);
});

for (const local of [
  { clients: "" },
  { clients: "/dev/ttys007\t987\t$0\t%0\t0\n/dev/ttys008\t988\t$0\t%0\t0" },
  { clients: "/dev/ttys007\t987\t$1\t%0\t0" },
  { clients: "/dev/ttys007\t987\t$0\t%1\t0" },
  { clients: "/dev/ttys007\t987\t$0\t%0\t1" },
  { clients: "bad;switch-client\t987\t$0\t%0\t0" },
  { clients: "/dev/ttys007\t987\t$0\t%0\t0\tUTF8,active-pane" },
  { sourcePid: "124" },
  { sourcePane: "%1" },
  { sourceTTY: "/dev/null" },
  { linked: "1" },
])
  test(`unverified or ambiguous source ownership refuses all local mutations: ${JSON.stringify(local)}`, async (t) => {
    const fixture = tmuxFixture(t, "ok", "ok", { sameServer: true, ...local });
    const { tui, events } = tty(t);
    env(t, "TMUX", "/tmp/outer,123,0");
    env(t, "TMUX_PANE", "%0");
    await assert.rejects(
      attachTmux(tui, target, new AbortController().signal),
      /Cannot (verify|identify)/,
    );
    assert.deepEqual(events, []);
    assert.ok(
      fixture
        .calls()
        .every((args) => ["display-message", "list-clients"].includes(args[2])),
    );
  });

for (const presence of [
  { TMUX: "/tmp/outer,123,0", TMUX_PANE: undefined },
  { TMUX: "relative,123,0", TMUX_PANE: "%0" },
  { TMUX: undefined, TMUX_PANE: "%0" },
])
  test(`invalid tmux presence never falls back to a nested attach: ${JSON.stringify(presence)}`, async (t) => {
    const fixture = tmuxFixture(t);
    const { tui, events } = tty(t);
    for (const [key, value] of Object.entries(presence)) env(t, key, value);
    await assert.rejects(
      attachTmux(tui, target, new AbortController().signal),
      /Cannot verify/,
    );
    assert.deepEqual(events, []);
    assert.equal(fixture.calls().length, 1);
  });

test("a queued ownership failure rejects instead of reporting a successful switch", async (t) => {
  tmuxFixture(t, "ok", "ok", {
    sameServer: true,
    queueOutput: "That tmux agent moved or exited. Refresh /agents.\nswitched",
  });
  const { tui, events } = tty(t);
  env(t, "TMUX", "/tmp/outer,123,0");
  env(t, "TMUX_PANE", "%0");
  await assert.rejects(
    attachTmux(tui, target, new AbortController().signal),
    /moved or exited/,
  );
  assert.deepEqual(events, []);
});

test("cancelled local opening performs no probes or terminal handoff", async (t) => {
  const fixture = tmuxFixture(t);
  const { tui, events } = tty(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(attachTmux(tui, target, abort.signal), /abort/i);
  assert.deepEqual(events, []);
  assert.deepEqual(fixture.calls(), []);
});

test("session-only opening pins its observed pane before handing off", async (t) => {
  const fixture = tmuxFixture(t);
  const { tui } = tty(t);
  await attachTmux(
    tui,
    { socket: target.socket, session: target.session },
    new AbortController().signal,
  );
  const queue = fixture.calls().at(-1);
  assert.deepEqual(queue.slice(2, 6), ["if-shell", "-F", "-t", "%7"]);
  assert.equal(
    queue[6],
    "#{==:#{pid} #{session_id} #{window_id} #{pane_id} #{window_linked},456 $42 @2 %7 0}",
  );
  assert.match(queue[7], /attach-session.*\$42:@2\.%7/);
});

const realTmux = spawnSync("which", ["tmux"], {
  encoding: "utf8",
}).stdout?.trim();
test(
  "private real tmux and fake Claude map a wrapper descendant to its native row",
  { skip: !realTmux, timeout: 10_000 },
  async (t) => {
    const root = temporary(t);
    const socket = join(root, "s");
    const bin = join(root, "bin");
    const cwd = join(root, "project");
    const record = join(root, "native.json");
    const log = join(root, "tmux-calls.jsonl");
    mkdirSync(bin);
    mkdirSync(cwd);
    env(t, "PATH", `${bin}:${process.env.PATH}`);
    env(t, "TMUX", undefined);
    env(t, "TMUX_PANE", undefined);
    writeFileSync(
      join(bin, "tmux"),
      `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
const r = cp.spawnSync(${JSON.stringify(realTmux)}, ['-S', ${JSON.stringify(socket)}, '-f', '/dev/null', ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(r.status ?? 1);`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== '["agents","--json"]') process.exit(9);
console.log(require('node:fs').readFileSync(${JSON.stringify(record)}, 'utf8'));`,
      { mode: 0o700 },
    );
    const fake = join(root, "fake-claude.mjs");
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify([{ sessionId: 'fake-session', cwd: process.cwd(), pid: process.pid, name: 'project-65', status: 'idle' }])); setInterval(() => {}, 1000);`,
    );
    const wrapper = join(root, "wrapper.mjs");
    writeFileSync(
      wrapper,
      `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(fake)}], { stdio: 'inherit' }); child.on('exit', code => process.exit(code ?? 1));`,
    );
    t.after(() => spawnSync(realTmux, ["-S", socket, "kill-server"]));
    execFileSync(realTmux, [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "job-4abb1f45",
      "-c",
      cwd,
      process.execPath,
      wrapper,
    ]);
    execFileSync(realTmux, [
      "-S",
      socket,
      "set-option",
      "-w",
      "-t",
      "=job-4abb1f45:",
      "@pi-agents-agent",
      "claude",
    ]);
    for (let i = 0; i < 100 && !existsSync(record); i++)
      await new Promise((done) => setTimeout(done, 20));
    assert.ok(existsSync(record), "fake Claude must report its PID");
    const nativeRows = await createClaudeAdapter().list(
      AbortSignal.timeout(3000),
    );
    const panes = await createLocalTmuxAdapter(() => []).list(
      AbortSignal.timeout(3000),
    );
    assert.equal(panes.length, 1);
    assert.notEqual(
      panes[0].pid,
      nativeRows[0].pid,
      "fixture must use a wrapper",
    );
    assert.ok(panes[0].tmuxPids.includes(nativeRows[0].pid));
    const merged = mergeLocalTmux([...nativeRows, ...panes]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "project-65");
    assert.equal(merged[0].status, "ready");
    assert.equal(merged[0].tmux.socket, socket);
    assert.equal(merged[0].tmuxName, "job-4abb1f45");
    assert.ok(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .every((args) => args[0] === "list-panes"),
    );
  },
);

const python = "/usr/bin/python3";
for (const mode of [
  "same-server",
  "same-server-fullscreen",
  "same-session",
  "other-server",
  "moved-target",
  "moved-client",
  "ambiguous",
  "linked-source",
])
  test(
    `private PTY local opening ${mode} preserves the runtime, draft and unrelated client`,
    {
      skip: !realTmux || spawnSync(python, ["--version"]).status !== 0,
      timeout: 20_000,
    },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-agents-attach-"));
      const socket = join(root, "s");
      symlinkSync(root, join(root, "alias"));
      const targetSocket =
        mode === "other-server"
          ? join(root, "target's, socket")
          : join(root, "alias/s");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const record = join(root, "result.json");
      const targetFile = join(root, "target.json");
      const host = join(root, "host.mjs");
      const agent = join(root, "agent.mjs");
      writeFileSync(
        agent,
        "process.stdout.write('EXACT-AGENT\\n');process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000);",
      );
      writeFileSync(
        join(bin, "tmux"),
        `#!${process.execPath}
const cp = require('node:child_process'); const fs = require('node:fs');
const args = process.argv.slice(2); const mode = ${JSON.stringify(mode)};
const real = ${JSON.stringify(realTmux)}; const socket = ${JSON.stringify(socket)};
if (args[1] === socket && args[2] === 'if-shell') {
  if (mode === 'moved-target') {
    const target = JSON.parse(fs.readFileSync(${JSON.stringify(targetFile)}, 'utf8'));
    cp.execFileSync(real, ['-S', socket, 'move-window', '-d', '-s', target.pane, '-t', '$2:']);
  }
  if (mode === 'moved-client') {
    const client = cp.execFileSync(real, ['-S', socket, 'list-clients', '-t', '$0', '-F', '#{client_name}'], {encoding:'utf8'}).trim();
    cp.execFileSync(real, ['-S', socket, 'switch-client', '-c', client, '-t', '$2']);
  }
}
const result = cp.spawnSync(real, args, {stdio:'inherit'}); process.exit(result.status ?? 1);`,
        { mode: 0o700 },
      );
      writeFileSync(
        host,
        `import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(${JSON.stringify(join(packageDir, "package.json"))});
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, {alias:{'@earendil-works/pi-tui':${JSON.stringify(tuiPath)}}});
const { attachTmux } = await jiti.import(${JSON.stringify(join(source, "attach.ts"))});
const { ProcessTerminal, Input, Text } = await import(${JSON.stringify(pathToFileURL(tuiPath).href)});
const { ${mode === "same-server" ? "TuiMainScreen" : "TuiAltScreen"}: Renderer } = await import(${JSON.stringify(pathToFileURL(join(dirname(tuiPath), mode === "same-server" ? "tui-main-screen.js" : "tui-alt-screen.js")).href)});
const tui = new Renderer(new ProcessTerminal());
const input = new Input(); input.setValue('unsent-draft'); input.handleInput('\\x05');
const handleInput = input.handleInput.bind(input);
input.handleInput = data => {handleInput(data); tui.requestRender();};
const status = new Text('PARENT-READY');
const beforePid = process.pid; const events = []; let busy = false;
input.onSubmit = async () => {
  if (busy) return; busy = true;
  const state = {beforePid};
  try {state.result = await attachTmux(tui, JSON.parse(readFileSync(${JSON.stringify(targetFile)}, 'utf8')), new AbortController().signal);}
  catch (error) {state.error = error.message;}
  Object.assign(state, {pid:process.pid, draft:input.getValue(), events});
  status.setText('PARENT-RETURNED'); tui.requestRender();
  writeFileSync(${JSON.stringify(record)}, JSON.stringify(state));
};
tui.addChild(status); tui.addChild(input); tui.setFocus(input); tui.start();
for (const method of ['stop','start']) {const original = tui[method].bind(tui); tui[method] = (...args) => {events.push(method); return original(...args);};}`,
      );
      const testEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMUX: "",
        TMUX_PANE: "",
        TERM: "xterm-256color",
      };
      const tmux = (server, ...args) =>
        execFileSync(realTmux, ["-S", server, ...args], {
          encoding: "utf8",
          env: testEnv,
        }).trim();
      t.after(() => {
        spawnSync(realTmux, ["-S", socket, "kill-server"]);
        if (mode === "other-server")
          spawnSync(realTmux, ["-S", targetSocket, "kill-server"]);
        rmSync(root, { recursive: true, force: true });
      });
      tmux(
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "parent",
        process.execPath,
        host,
      );
      const session =
        mode === "same-session"
          ? "$0"
          : tmux(
              targetSocket,
              "-f",
              "/dev/null",
              "new-session",
              "-d",
              "-P",
              "-F",
              "#{session_id}",
              "-s",
              "agent",
              process.execPath,
              "-e",
              "process.stdout.write('DECOY');setInterval(()=>{},1000)",
            );
      const pane = tmux(
        targetSocket,
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        session,
        process.execPath,
        agent,
      );
      tmux(
        targetSocket,
        "split-window",
        "-t",
        pane,
        process.execPath,
        "-e",
        "process.stdout.write('WRONG-PANE');setInterval(()=>{},1000)",
      );
      tmux(targetSocket, "select-window", "-t", `${session}:0`);
      writeFileSync(
        targetFile,
        JSON.stringify({ socket: targetSocket, session, pane }),
      );
      const spectator = tmux(
        socket,
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        "spectator",
        process.execPath,
        "-e",
        "process.stdout.write('SPECTATOR');setInterval(()=>{},1000)",
      );
      if (mode === "linked-source")
        tmux(socket, "link-window", "-d", "-s", "@0", "-t", `${spectator}:`);
      const script = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct
real, socket, record, mode, session, pane, spectator = sys.argv[1:]
def tmux(*args):
    return subprocess.check_output([real, '-S', socket, *args], text=True).strip()
def attach(target):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',30,140,0,0))
    def setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    p = subprocess.Popen([real,'-S',socket,'attach-session','-t',target],stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup)
    os.close(slave)
    return p, master
def wait_for(master, marker):
    data = b''
    end = time.time()+6
    while marker not in data:
        if time.time()>end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-2000:]))
        if select.select([master],[],[],.05)[0]: data += os.read(master,65536)
    return data
clients = []
try:
    owner, master = attach('$0'); clients.append((owner,master))
    wait_for(master,b'PARENT-READY')
    other, other_master = attach('$0' if mode=='ambiguous' else spectator); clients.append((other,other_master))
    wait_for(other_master,b'PARENT-READY' if mode=='ambiguous' else b'SPECTATOR')
    os.write(master,b'\\r')
    end = time.time()+7
    while not os.path.exists(record):
        if time.time()>end: raise RuntimeError('no opening result: '+tmux('capture-pane','-p','-t','%0'))
        time.sleep(.03)
    state = json.load(open(record))
    assert state['pid']==state['beforePid'] and state['draft']=='unsent-draft' and state['events']==[], state
    def identities():
        return {int(row[0]):row[1:] for row in (line.split('\\t') for line in tmux('list-clients','-F','#{client_pid}\\t#{client_name}\\t#{session_id}\\t#{pane_id}').splitlines())}
    info = identities()
    assert info[other.pid][1]==('$0' if mode=='ambiguous' else spectator), info
    if mode in ('moved-target','moved-client','ambiguous','linked-source'):
        assert 'error' in state, state
        expected = 'Cannot verify' if mode=='linked-source' else ('ambiguous' if mode=='ambiguous' else 'moved or exited')
        assert expected in state['error'], state
        assert info[owner.pid][1]==(spectator if mode=='moved-client' else '$0'), info
    elif mode=='other-server':
        assert state.get('result')=='window' and info[owner.pid][1]=='$0' and info[owner.pid][2]!='%0', (state,info)
        wait_for(master,b'EXACT-AGENT')
    else:
        assert state.get('result')=='switched' and info[owner.pid][1:]==[session,pane], (state,info)
        wait_for(master,b'EXACT-AGENT')
    tmux('switch-client','-c',info[owner.pid][0],'-t','$0:@0.%0')
    wait_for(master,b'PARENT-RETURNED')
    os.write(master,b'!')
    end = time.time()+3
    while 'unsent-draft!' not in tmux('capture-pane','-p','-t','%0'):
        if time.time()>end: raise RuntimeError('parent input did not survive')
        time.sleep(.03)
    print(json.dumps(state))
finally:
    for child, fd in clients:
        child.terminate()
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
        os.close(fd)
`;
      const state = JSON.parse(
        execFileSync(
          python,
          [
            "-c",
            script,
            realTmux,
            socket,
            record,
            mode,
            session,
            pane,
            spectator,
          ],
          { encoding: "utf8", timeout: 18_000, env: testEnv },
        ),
      );
      assert.equal(state.draft, "unsent-draft");
      assert.equal(
        tmux(targetSocket, "display-message", "-p", "-t", pane, "#{pane_dead}"),
        "0",
      );
    },
  );

for (const mode of ["regular", "fullscreen"])
  test(
    `real PTY ${mode} attaches, accepts agent input, detaches back to Pi's renderer and leaves the job alive`,
    {
      skip: !realTmux || spawnSync(python, ["--version"]).status !== 0,
      timeout: 20_000,
    },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-agents-pty-"));
      const socket = join(root, "s");
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec '${realTmux}' "$@"\n`, {
        mode: 0o700,
      });
      const agent = join(root, "agent.mjs");
      writeFileSync(
        agent,
        `process.stdout.write('AGENT-READY\\n'); process.stdin.on('data', d => process.stdout.write('AGENT-ECHO:'+d)); setInterval(() => {}, 1000);`,
      );
      execFileSync(
        realTmux,
        [
          "-S",
          socket,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "job",
          process.execPath,
          agent,
        ],
        { env: { ...process.env, TMUX: "", TMUX_PANE: "" } },
      );
      t.after(() => {
        spawnSync(realTmux, ["-S", socket, "kill-server"]);
        rmSync(root, { recursive: true, force: true });
      });
      execFileSync(realTmux, [
        "-S",
        socket,
        "new-window",
        "-d",
        "-t",
        "$0",
        process.execPath,
        "-e",
        "process.stdout.write('OTHER-WINDOW');setInterval(() => {}, 1000)",
      ]);
      execFileSync(realTmux, ["-S", socket, "select-window", "-t", "$0:1"]);
      const host = join(root, "host.mjs");
      writeFileSync(
        host,
        `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(packageDir, "package.json"))});
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': ${JSON.stringify(join(packageDir, "dist/index.js"))}, '@earendil-works/pi-tui': ${JSON.stringify(tuiPath)} } });
const { ProcessTerminal } = await import(${JSON.stringify(pathToFileURL(tuiPath).href)});
const { ${mode === "regular" ? "TuiMainScreen" : "TuiAltScreen"}: Renderer } = await import(${JSON.stringify(pathToFileURL(join(dirname(tuiPath), mode === "regular" ? "tui-main-screen.js" : "tui-alt-screen.js")).href)});
const { Dashboard } = await jiti.import(${JSON.stringify(join(source, "dashboard.ts"))});
const { attachTmux } = await jiti.import(${JSON.stringify(join(source, "attach.ts"))});
const { getThemeByName } = await import(${JSON.stringify(pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js")).href)});
const { getKeybindings } = await import(${JSON.stringify(pathToFileURL(tuiPath).href)});
const tui = new Renderer(new ProcessTerminal());
const view = new Dashboard(tui, getThemeByName('dark'), getKeybindings(), '/project', () => { tui.stop(); process.exit(0); }, () => {}, () => {}, undefined, undefined, true, (target, signal) => attachTmux(tui, target, signal));
view.setData([{ source: 'tmux', key: 'job', title: 'PARENT-DASHBOARD', cwd: '/project', status: 'unknown', updated: 0, owners: [], current: false, live: true, tmux: { socket: ${JSON.stringify(socket)}, session: '$0', pane: '%0' } }]);
tui.addChild(view); tui.setFocus(view); tui.start();`,
      );
      const script = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 140, 0, 0))
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
os.close(slave)
data = b''
def wait_for(marker):
    global data
    end = time.time() + 8
    while marker not in data:
        if time.time() > end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-4000:]))
        if select.select([master], [], [], .1)[0]: data += os.read(master, 65536)
wait_for(b'PARENT-DASHBOARD')
os.write(master, b'\\r')
wait_for(b'AGENT-READY')
os.write(master, b'hello-agent\\r')
wait_for(b'AGENT-ECHO:hello-agent')
os.write(master, b'\\x02d')
wait_for(b'Returned to Agents')
os.write(master, b'\\x1b')
end = time.time() + 5
while p.poll() is None and time.time() < end:
    if select.select([master], [], [], .05)[0]:
        try: data += os.read(master, 65536)
        except OSError: break
if p.poll() is None:
    p.kill()
    p.wait()
    raise RuntimeError('host did not close: '+repr(data[-4000:]))
print(json.dumps({'returned': True, 'exit': p.returncode}))
os.close(master)
`;
      const result = execFileSync(
        python,
        ["-c", script, process.execPath, host],
        {
          encoding: "utf8",
          timeout: 18_000,
          env: {
            ...process.env,
            PATH: bin + ":" + process.env.PATH,
            TERM: "xterm-256color",
            TMUX: "",
            TMUX_PANE: "",
          },
        },
      );
      assert.deepEqual(JSON.parse(result), { returned: true, exit: 0 });
      assert.equal(
        execFileSync(
          realTmux,
          ["-S", socket, "display-message", "-p", "-t", "$0", "#{pane_dead}"],
          { encoding: "utf8" },
        ).trim(),
        "0",
      );
    },
  );
