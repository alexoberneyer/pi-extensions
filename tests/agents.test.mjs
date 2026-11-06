import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
const entry = join(packageDir, "dist/index.js");
const tuiPath = require.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": entry,
    "@earendil-works/pi-tui": tuiPath,
  },
});
const source = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/agents",
);
const {
  Registry,
  STALE_MS,
  age,
  filterRows,
  mergeRows,
  pathKey,
  plain,
  textContent,
} = await jiti.import(join(source, "state.ts"));
const { Dashboard } = await jiti.import(join(source, "dashboard.ts"));
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { SessionManager } = await import(pathToFileURL(entry));
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } =
  await import(pathToFileURL(tuiPath));

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function record(overrides = {}) {
  return {
    version: 1,
    instance: "instance-a",
    pid: process.pid,
    sessionId: "session-a",
    sessionFile: "/project/session.jsonl",
    cwd: "/project",
    title: "Current task",
    preview: "Last response",
    model: "test/model",
    status: "ready",
    updated: 1_000,
    heartbeat: Date.now(),
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    source: "pi",
    live: false,
    key: "saved",
    sessionFile: "/project/saved.jsonl",
    cwd: "/project",
    title: "Saved task",
    preview: "Saved response",
    model: "",
    status: "inactive",
    updated: Date.now(),
    current: false,
    owners: [],
    ...overrides,
  };
}

function makeDashboard(rows = [], options = {}) {
  const terminal = { rows: options.height || 30 };
  const state = { result: null, renders: 0, refreshes: 0, cleanups: 0 };
  const tui = {
    terminal,
    requestRender() {
      state.renders++;
    },
  };
  const view = new Dashboard(
    tui,
    options.theme || getThemeByName("dark"),
    options.keys || getKeybindings(),
    "/project",
    (value) => {
      state.result = value ?? "closed";
    },
    () => {
      state.refreshes++;
    },
    () => {
      state.cleanups++;
    },
    options.copy,
    options.launcher,
    options.remoteLaunch ?? true,
    options.opener,
    options.closer,
  );
  view.setData(rows);
  for (let i = 0; i < (options.filter || 0); i++) view.handleInput("\t");
  return { view, state, terminal };
}

async function harness(t) {
  const root = temporary(t);
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldExternal = process.env.PI_AGENTS_EXTERNAL;
  const oldDev01 = process.env.PI_AGENTS_DEV01;
  process.env.PI_AGENTS_DEV01 = "0"; // No real SSH even when a test enables local discovery.
  process.env.PI_AGENTS_EXTERNAL = "0"; // Never inspect real Claude/Codex sessions in tests.
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (oldDev01 === undefined) delete process.env.PI_AGENTS_DEV01;
    else process.env.PI_AGENTS_DEV01 = oldDev01;
    if (oldExternal === undefined) delete process.env.PI_AGENTS_EXTERNAL;
    else process.env.PI_AGENTS_EXTERNAL = oldExternal;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
  });
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const manager = SessionManager.create(cwd, join(root, "sessions-custom"));
  const extensionLink = join(root, "agents-extension");
  symlinkSync(resolve(source, "../.."), extensionLink);
  const loaded = await loadExtensions(
    [join(extensionLink, "extensions/agents/index.ts")],
    cwd,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(
    readdirSync(root).includes("agents-status"),
    false,
    "factory must not start resources",
  );
  const state = {
    busy: false,
    queued: false,
    draft: "",
    notices: [],
    switches: [],
    confirms: 0,
    view: null,
  };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    model: { provider: "test", id: "model" },
    isIdle: () => !state.busy,
    hasPendingMessages: () => state.queued,
    ui: {
      notify: (message, level) => state.notices.push({ message, level }),
      getEditorText: () => state.draft,
      confirm: async () => {
        state.confirms++;
        return true;
      },
      custom: async (factory) =>
        new Promise((done) => {
          state.view = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            getThemeByName("dark"),
            getKeybindings(),
            done,
          );
        }),
    },
    switchSession: async (path) => {
      const results = await emit("session_before_switch", {
        reason: "resume",
        targetSessionFile: path,
      });
      if (results.some((result) => result?.cancel)) return { cancelled: true };
      state.switches.push(path);
      return { cancelled: false };
    },
  };
  async function emit(type, event = {}) {
    const result = [];
    for (const handler of extension.handlers.get(type) || [])
      result.push(await handler({ type, ...event }, ctx));
    return result;
  }
  await emit("session_start");
  t.after(() => emit("session_shutdown"));
  const registry = new Registry(join(root, "agents-status"));
  return {
    root,
    cwd,
    manager,
    state,
    ctx,
    emit,
    registry,
    current: () => registry.list()[0],
    command: () => extension.commands.get("agents").handler("", ctx),
  };
}

function showHistory(view) {
  for (let i = 0; i < 4; i++) view.handleInput("\t");
  assert.match(plain(view.render(100)[1]), /History \d+/);
}

async function tick() {
  await new Promise((done) => setImmediate(done));
}

// Private, cross-process presence records.
test("presence writes are atomic, private and independently cleaned up", (t) => {
  const directory = join(temporary(t), "status");
  const a = new Registry(directory);
  const b = new Registry(directory);
  a.write(record());
  b.write(record({ title: "Second" }));
  assert.equal(a.list().length, 2);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(a.file).mode & 0o777, 0o600);
  assert.equal(
    readdirSync(directory).some((file) => file.endsWith(".tmp")),
    false,
  );
  a.dispose();
  a.dispose();
  assert.equal(b.list()[0].title, "Second");
  b.dispose();
  assert.deepEqual(b.list(), []);
});

test("registry ignores malformed, oversized, symlink and dead-PID records", (t) => {
  const directory = temporary(t);
  const registry = new Registry(directory);
  registry.write(record());
  writeFileSync(join(directory, "aa.json"), "{");
  writeFileSync(
    join(directory, "bb.json"),
    JSON.stringify({ pid: process.pid }),
  );
  writeFileSync(join(directory, "cc.json"), " ".repeat(20_000));
  symlinkSync(registry.file, join(directory, "dd.json"));
  assert.equal(registry.list().length, 1);
  assert.deepEqual(
    registry.list(() => false),
    [],
  );
  assert.equal(
    readdirSync(directory).length,
    5,
    "reading never deletes somebody else's record",
  );
});

test("invalid optional tmux metadata never removes a live session owner", (t) => {
  const registry = new Registry(temporary(t));
  registry.write(record({ tmux: { socket: "relative", pane: "bad" } }));
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].tmux, undefined);
  registry.dispose();
});

test("registry read failures are surfaced rather than falsely reporting no owners", (t) => {
  const file = join(temporary(t), "not-a-directory");
  writeFileSync(file, "x");
  assert.throws(() => new Registry(file).list(), /ENOTDIR/);
});

test("live records override history, include unsaved sessions and preserve ownership", () => {
  const saved = {
    path: "/project/session.jsonl",
    id: "session-a",
    cwd: "/project",
    firstMessage: "Old",
    allMessagesText: "Old text",
    modified: new Date(1),
  };
  const current = record({ title: "Renamed", status: "working" });
  const liveOnly = record({
    instance: "instance-b",
    sessionFile: undefined,
    sessionId: "unsaved",
  });
  const rows = mergeRows([saved], [current, liveOnly], current.instance);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Renamed");
  assert.equal(rows[0].status, "working");
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].sessionFile, undefined);
});

test("stale live owners and duplicate owners are Unknown, never Inactive", () => {
  const stale = record({ heartbeat: Date.now() - STALE_MS - 1 });
  let rows = mergeRows([], [stale], "other");
  assert.equal(rows[0].status, "unknown");
  assert.equal(rows[0].owners.length, 1);
  rows = mergeRows([], [record(), record({ instance: "b" })], "other");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unknown");
  assert.equal(rows[0].owners.length, 2);
});

test("realpath identities merge symlinked session paths", (t) => {
  const directory = temporary(t);
  const original = join(directory, "original.jsonl");
  const link = join(directory, "alias.jsonl");
  writeFileSync(original, "");
  symlinkSync(original, link);
  assert.equal(pathKey(original), pathKey(link));
  assert.equal(
    mergeRows(
      [],
      [record({ sessionFile: original }), record({ sessionFile: link })],
      "other",
    ).length,
    1,
  );
});

test("plain previews strip control sequences and never expose thinking or images", () => {
  assert.equal(
    plain("hello\x1b[31m red\x1b[0m\x1b]52;c;abc\x07\nworld\u202e"),
    "hello red world",
  );
  assert.equal(
    textContent({
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "image", data: "base64" },
        { type: "text", text: "Visible text" },
      ],
    }),
    "Visible text",
  );
  assert.equal(plain("x".repeat(3_000)).length, 1_200);
});

test("filters combine scope and search while Needs you includes errors", () => {
  const rows = [
    row({ title: "API fix", status: "error" }),
    row({ key: "b", title: "API plan", status: "working", cwd: "/other" }),
  ];
  assert.equal(filterRows(rows, 1, "api").length, 1);
  assert.equal(filterRows(rows, 2, "api").length, 1);
  assert.equal(filterRows(rows, 0, "api", "/project").length, 1);
  assert.equal(filterRows(rows, 0, "api fix").length, 1);
  assert.equal(filterRows(rows, 4, "").length, 0);
  assert.equal(age(3_000, 1_000), "0s");
  assert.equal(age(1, 3_600_001), "1h");
  assert.equal(age(0), "?");
});

// Rendering and navigation use Pi's actual terminal components and theme.
test("Sessions hides history but retains operational rows with unavailable state", () => {
  const saved = row({ title: "History-only task" });
  const unknown = row({
    key: "unknown",
    title: "Unreported task",
    status: "unknown",
    live: true,
    owners: [record()],
  });
  const { view } = makeDashboard([saved, unknown]);
  assert.equal(view.selectedRow().key, unknown.key);
  const text = view.render(140).join("\n");
  assert.match(text, /Unreported task/);
  assert.match(text, /State unavailable/);
  assert.doesNotMatch(text, /History-only task/);
  view.handleInput("\t"); // Needs you never treats unknown as an approval request.
  assert.equal(view.selectedRow(), undefined);
  for (let i = 0; i < 3; i++) view.handleInput("\t"); // History
  assert.equal(view.selectedRow().key, saved.key);
  assert.match(view.render(140).join("\n"), /Saved/);
  view.handleInput("\t"); // All
  assert.match(view.render(140).join("\n"), /Unreported task/);
  assert.match(view.render(140).join("\n"), /History-only task/);
  view.handleInput("\t"); // Sessions
  assert.equal(view.selectedRow().key, unknown.key);
  view.handleInput("\x1b[Z"); // Shift+Tab reaches All in reverse.
  assert.match(view.render(140).join("\n"), /History-only task/);
});

test("tmux filtering and job-name search retain merged native tool identity", () => {
  const attached = row({
    source: "claude",
    key: "claude:attached",
    title: "Native Claude title",
    status: "ready",
    tmux: { socket: "/tmp/filter.sock", session: "$42", pane: "%7" },
    tmuxName: "job-4abb1f45",
  });
  const original = row({
    source: "claude",
    key: "claude:original",
    status: "ready",
  });
  assert.deepEqual(filterRows([attached, original], 0, "", undefined, "tmux"), [
    attached,
  ]);
  assert.deepEqual(filterRows([attached, original], 0, "job-4abb1f45"), [
    attached,
  ]);
  assert.deepEqual(filterRows([attached, original], 0, "tmux"), [attached]);
  const { view } = makeDashboard([attached, original]);
  for (let i = 0; i < 4; i++) view.handleInput("\x0f");
  assert.equal(view.selectedRow().key, attached.key);
  assert.match(view.render(140).join("\n"), /\[Claude\] Native Claude title/);
});

test("tab counts include scoped history and count only actionable Needs-you states", () => {
  const rows = [
    "waiting",
    "error",
    "stopped",
    "working",
    "ready",
    "unknown",
  ].map((status) => row({ key: status, title: status, status }));
  rows.push(
    row({ key: "saved-other", cwd: "/other" }),
    row({ key: "saved-remote", source: "claude", host: "dev01" }),
  );
  const { view } = makeDashboard(rows);
  const counts = () => plain(view.render(140)[1]);
  assert.match(counts(), /Sessions 6/);
  assert.match(counts(), /Needs you 3/);
  assert.match(counts(), /Working 1/);
  assert.match(counts(), /Idle 1/);
  assert.match(counts(), /History 2/);
  assert.match(counts(), /All 8/);
  assert.deepEqual(
    filterRows(rows, 1, "").map((agent) => agent.status),
    ["waiting", "error", "stopped"],
  );
  view.handleInput("ready"); // Search does not change scope counts.
  assert.match(counts(), /All 8/);
  view.handleInput("\x0f"); // Pi only
  assert.match(counts(), /History 1/);
  assert.match(counts(), /All 7/);
  view.handleInput("\x10"); // Current local project
  assert.match(counts(), /History 0/);
  assert.match(counts(), /All 6/);
});

test("Needs-you rows precede idle current Pi without changing project grouping or selection", () => {
  const rows = [
    row({ key: "idle", title: "Current idle", status: "ready", current: true }),
    row({ key: "unknown", title: "Unavailable", status: "unknown" }),
    row({ key: "stopped", title: "Stopped task", status: "stopped" }),
    row({ key: "error", title: "Failed task", status: "error" }),
    row({ key: "waiting", title: "Approval task", status: "waiting" }),
    row({
      key: "other",
      title: "Other urgent",
      status: "waiting",
      cwd: "/aaa",
    }),
    row({
      key: "remote",
      title: "Remote urgent",
      status: "waiting",
      host: "dev01",
    }),
  ];
  const { view } = makeDashboard(rows);
  assert.equal(view.selectedRow().key, "idle");
  const list = view
    .render(140)
    .map((line) => plain(line))
    .filter((line) => /[●○] \[/.test(line));
  assert.deepEqual(
    list.map((line) => rows.find((agent) => line.includes(agent.title))?.key),
    ["waiting", "error", "stopped", "idle", "unknown", "other", "remote"],
  );
  view.handleInput("\x1b[A");
  assert.equal(view.selectedRow().key, "stopped");
  view.setData(rows.slice().reverse());
  assert.equal(view.selectedRow().key, "stopped");
});

test("wide layouts keep metadata near titles and show full unavailable state with n/a activity", () => {
  const { view } = makeDashboard([
    row({
      source: "claude",
      title: "Native task",
      status: "unknown",
      updated: 0,
    }),
  ]);
  const table = (width) =>
    view
      .render(width)
      .map(stripTerminalSequences)
      .find((line) => line.includes("○ [Claude]"));
  const baseline = table(102);
  assert.match(baseline, /State unavailable\s+n\/a/);
  assert.doesNotMatch(baseline, /\?/);
  assert.equal(baseline.indexOf("State unavailable"), 75);
  for (const width of [140, 220]) {
    const lines = view.render(width).map(stripTerminalSequences);
    const line = table(width);
    assert.equal(
      line.indexOf("State unavailable"),
      baseline.indexOf("State unavailable"),
    );
    assert.equal(line.indexOf("n/a"), baseline.indexOf("n/a"));
    assert.ok(lines.every((text) => visibleWidth(text.trimEnd()) <= 101));
  }
  assert.match(table(55), /State unavailable/);
});

test("unavailable operational state uses muted color rather than warning", () => {
  const actual = getThemeByName("dark");
  const calls = [];
  const theme = {
    bold: (text) => actual.bold(text),
    bg: (color, text) => actual.bg(color, text),
    fg: (color, text) => {
      calls.push({ color, text });
      return actual.fg(color, text);
    },
  };
  const { view } = makeDashboard(
    [
      row({
        key: "current",
        title: "Current idle",
        status: "ready",
        current: true,
      }),
      row({ key: "unknown", title: "Unreported task", status: "unknown" }),
    ],
    { theme },
  );
  view.render(140);
  const unavailable = calls.filter(({ text }) =>
    /[●○] \[.*Unreported task/.test(text),
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].color, "muted");
});

test("Enter labels match guarded actions for current, attached, saved and external rows", async () => {
  const target = {
    socket: "/tmp/action-test.sock",
    session: "$42",
    pane: "%7",
  };
  const cases = [
    {
      agent: row({
        current: true,
        status: "working",
        owners: [record()],
        tmux: target,
      }),
      label: "Return to current Pi",
      result: "closed",
    },
    {
      agent: row({ status: "ready", owners: [record()], tmux: target }),
      label: "Attach local tmux",
      attach: true,
    },
    {
      agent: row({ source: "claude", status: "ready", tmux: target }),
      label: "Attach local tmux",
      attach: true,
    },
    { agent: row(), filter: 4, label: "Resume saved Pi", resume: true },
    {
      agent: row({ source: "codex", nativeCommand: "codex resume 'saved'" }),
      filter: 5,
      label: "Show command",
    },
    {
      agent: row({ status: "unknown", tmux: target, owners: [] }),
      label: "Terminal guidance",
    },
    {
      agent: row({
        status: "unknown",
        tmux: target,
        owners: [record(), record({ instance: "b" })],
      }),
      label: "Terminal guidance",
    },
    {
      agent: row({
        source: "claude",
        status: "ready",
        tmux: target,
        nativeCommand: "claude attach 'native'",
      }),
      noOpener: true,
      label: "Show command",
    },
    {
      agent: row({
        source: "claude",
        status: "unknown",
        tmux: { ...target, session: "unsafe" },
        nativeCommand: "claude attach 'native'",
      }),
      label: "Show command",
    },
    {
      agent: row({
        host: "dev01",
        current: true,
        status: "working",
        owners: [record()],
        tmux: target,
        nativeCommand: "ssh -t dev01 tmux",
      }),
      label: "Show command",
    },
    {
      agent: row({ source: "claude", status: "ready", pid: 123 }),
      label: "Terminal guidance",
    },
    {
      agent: row({
        status: "unknown",
        sessionFile: "/project/operational.jsonl",
      }),
      label: "Terminal guidance",
    },
  ];
  for (const entry of cases) {
    const opened = [];
    const { view, state } = makeDashboard([entry.agent], {
      filter: entry.filter,
      opener: entry.noOpener
        ? undefined
        : async (target) => opened.push(target),
    });
    assert.ok(
      view.render(140).join("\n").includes(`Enter: ${entry.label}`),
      entry.label,
    );
    view.handleInput("\r");
    await tick();
    assert.deepEqual(opened, entry.attach ? [target] : [], entry.label);
    assert.equal(
      state.result,
      entry.resume ? entry.agent : (entry.result ?? null),
      entry.label,
    );
    if (entry.label === "Show command")
      assert.ok(
        view.render(140).join("\n").includes(entry.agent.nativeCommand),
      );
    if (entry.label === "Terminal guidance")
      assert.match(
        view.render(140).join("\n"),
        /Use its original terminal|Live takeover is disabled/,
      );
  }
});

test("selected details separate connection from native titles and preserve message preview", () => {
  const target = {
    socket: "/tmp/connection-test.sock",
    session: "$42",
    pane: "%7",
  };
  for (const entry of [
    {
      agent: row({
        source: "claude",
        title: "Real Claude title",
        status: "ready",
        tmux: target,
        tmuxName: "worker-job",
      }),
      connection: "Local tmux · worker-job · Session $42 · Pane %7",
    },
    {
      agent: row({ status: "ready", owners: [record({ pid: 123 })] }),
      connection: "Original terminal · PID 123",
    },
    { agent: row(), filter: 4, connection: "Saved conversation" },
    {
      agent: row({
        host: "dev01",
        status: "unknown",
        remoteTmux: { ...target, host: "dev01", sshHost: "build-box" },
        tmuxName: "remote-job",
      }),
      connection:
        "Remote host dev01 · tmux · remote-job · Session $42 · Pane %7",
    },
  ]) {
    const { view } = makeDashboard([entry.agent], { filter: entry.filter });
    const lines = view.render(140).map(stripTerminalSequences);
    const connection = lines.find((line) => line.includes("Connection:"));
    assert.ok(connection.includes(entry.connection));
    assert.match(lines.join("\n"), /Saved response/);
    const titles = lines.filter((line) => line.includes(entry.agent.title));
    assert.ok(titles.length >= 2);
    for (const title of titles) {
      assert.doesNotMatch(title, /\$42|%7|worker-job|remote-job|Connection:/);
    }
  }
});

test("external descriptions preserve both preview lines and keep native IDs out of titles", () => {
  const agent = row({
    source: "claude",
    nativeId: "ee1e0177-c05c-4729-a5b0-33dd2ae4816d",
    title: "Review local notes",
    preview:
      "Recent progress ".repeat(7) + "Second preview line stays visible.",
    status: "ready",
    updated: 0,
    live: true,
  });
  const { view } = makeDashboard([agent]);
  const lines = view.render(140).map(stripTerminalSequences);
  const output = lines.join("\n");
  assert.match(output, /Second preview line stays visible/);
  assert.doesNotMatch(output, /Activity time not provided by Claude/);
  assert.match(
    lines.find((line) => line.includes("Connection:")),
    /Conversation ee1e0177/,
  );
  for (const line of lines.filter((line) => line.includes(agent.title)))
    assert.doesNotMatch(line, /ee1e0177/);
});

test("healthy external rows show recent text even when native status is unknown", () => {
  const agent = row({
    source: "codex",
    status: "unknown",
    live: true,
    preview: "The parser now handles empty invoices.",
    detail: "Unrecognized native status, not conversation text.",
  });
  const { view } = makeDashboard([agent]);
  assert.match(
    view.render(140).join("\n"),
    /The parser now handles empty invoices/,
  );
  view.setData([
    { ...agent, live: false, detail: "Discovery unavailable. Last seen data." },
  ]);
  assert.match(
    view.render(140).join("\n"),
    /Discovery unavailable. Last seen data/,
  );
});

test("bounded search rendering preserves focus and its cursor marker across resize", () => {
  const { view } = makeDashboard([row({ status: "ready" })]);
  view.focused = true;
  view.handleInput("Search text");
  assert.ok(view.render(220)[2].includes(CURSOR_MARKER));
  view.render(35);
  view.invalidate();
  assert.equal(view.focused, true);
  assert.ok(view.render(140)[2].includes(CURSOR_MARKER));
});

test("dashboard renders within terminal bounds at narrow widths and short heights", () => {
  const long = row({
    title: "中文 🥋 ".repeat(50),
    preview: "Long response ".repeat(100),
    status: "ready",
    live: true,
    current: true,
  });
  const { view, terminal } = makeDashboard([long]);
  view.focused = true;
  for (const width of [1, 2, 12, 35, 38, 55, 58, 80, 102, 140, 220]) {
    for (const height of [4, 12, 14, 18, 40]) {
      terminal.rows = height;
      const lines = view.render(width);
      assert.equal(lines.length, height);
      for (const line of lines)
        assert.ok(
          visibleWidth(line) <= width,
          `overflow at ${width}x${height}: ${visibleWidth(line)}`,
        );
    }
  }
});

test("compact layout keeps the selected row and filter visible", () => {
  const { view, terminal } = makeDashboard([row({ title: "Fixture title" })]);
  showHistory(view);
  terminal.rows = 12;
  const compact = view.render(60).join("\n");
  assert.match(compact, /Fixture title/);
  assert.match(compact, /History/);
  assert.match(compact, /Enter: Resume saved Pi/);
  terminal.rows = 18;
  assert.match(view.render(40)[1], /History 1/);
});

test("dashboard keeps selection across live updates and sorts current project first", () => {
  const a = row({ key: "a", title: "First", status: "ready" });
  const b = row({
    key: "b",
    title: "Other project",
    cwd: "/aaa",
    status: "ready",
  });
  const { view } = makeDashboard([b, a]);
  assert.equal(view.selectedRow().key, "a");
  view.handleInput("\x1b[B");
  assert.equal(view.selectedRow().key, "b");
  view.setData([row({ key: "c", status: "working" }), a, b]);
  assert.equal(view.selectedRow().key, "b");
});

test("dashboard filters, searches, refreshes and closes without agent control", () => {
  const { view, state } = makeDashboard([
    row({ key: "a", title: "API", status: "working" }),
    row({ key: "b", title: "Frontend", status: "ready" }),
  ]);
  view.handleInput("\t"); // Needs you
  assert.equal(view.selectedRow(), undefined);
  view.handleInput("\t"); // Working
  assert.equal(view.selectedRow().key, "a");
  view.handleInput("Frontend");
  assert.equal(view.selectedRow(), undefined);
  view.handleInput("\x1b"); // Clear search, do not close yet.
  assert.equal(state.result, null);
  assert.equal(view.selectedRow().key, "a");
  view.handleInput("\x12"); // Ctrl+R
  assert.equal(state.refreshes, 1);
  view.handleInput("\x1b");
  assert.equal(state.result, "closed");
  view.dispose();
  view.dispose();
  assert.equal(state.cleanups, 1);
});

test("Enter on another live session never returns a resume action", () => {
  const { view, state } = makeDashboard([
    row({ owners: [record()], status: "ready" }),
  ]);
  view.handleInput("\r");
  assert.equal(state.result, null);
  assert.match(view.render(140).join("\n"), /Live takeover is disabled/);
});

test("Enter on current session closes dashboard even when working", () => {
  const { view, state } = makeDashboard([
    row({ current: true, status: "working", owners: [record()] }),
  ]);
  view.handleInput("\r");
  assert.equal(state.result, "closed");
});

test("tool badges and source filters compose with project and status filters", () => {
  const { view } = makeDashboard([
    row({ key: "pi", title: "Pi task", status: "ready" }),
    row({
      source: "claude",
      key: "claude:a",
      title: "Claude task",
      status: "waiting",
    }),
    row({
      source: "codex",
      key: "codex:a",
      title: "Codex task",
      status: "working",
      cwd: "/other",
    }),
  ]);
  assert.match(view.render(140).join("\n"), /\[Claude\]/);
  view.handleInput("\x0f"); // Ctrl+O: Pi
  assert.equal(view.selectedRow().key, "pi");
  view.handleInput("\x0f"); // Claude
  assert.equal(view.selectedRow().key, "claude:a");
  view.handleInput("\t"); // Needs you
  assert.equal(view.selectedRow().key, "claude:a");
  view.handleInput("\x0f"); // Codex, no Needs you rows
  assert.equal(view.selectedRow(), undefined);
  view.handleInput("\t"); // Working
  assert.equal(view.selectedRow().key, "codex:a");
  view.handleInput("\x10"); // Current project
  assert.equal(view.selectedRow(), undefined);
});

test("external Enter never returns a Pi switch, even with a sessionFile", () => {
  const { view, state } = makeDashboard([
    row({
      source: "claude",
      current: true,
      status: "ready",
      nativeCommand: "claude attach 'abc'",
    }),
  ]);
  view.handleInput("\r");
  assert.equal(state.result, null);
  assert.match(view.render(140).join("\n"), /Ctrl\+Y copies: claude attach/);
});

test("Ctrl+Y copies only an external native command without closing the dashboard", async () => {
  const copied = [];
  const { view, state } = makeDashboard(
    [
      row({
        source: "codex",
        nativeCommand: "codex resume 'abc'",
      }),
    ],
    { filter: 4, copy: async (command) => copied.push(command) },
  );
  view.handleInput("\x19");
  await tick();
  assert.deepEqual(copied, ["codex resume 'abc'"]);
  assert.equal(state.result, null);
  assert.match(view.render(140).join("\n"), /Native command copied/);
  view.setData([row({ nativeCommand: "do not copy" })]);
  view.handleInput("\x19");
  await tick();
  assert.equal(copied.length, 1);
});

test("clipboard failure stays in the dashboard and shows the command", async () => {
  const { view, state } = makeDashboard(
    [
      row({
        source: "claude",
        nativeCommand: "claude attach 'abc'",
      }),
    ],
    {
      filter: 4,
      copy: async () => {
        throw new Error("No clipboard");
      },
    },
  );
  view.handleInput("\x19");
  await tick();
  assert.equal(state.result, null);
  assert.match(view.render(140).join("\n"), /Clipboard unavailable/);
});

test("remote Pi is labelled, searchable, copy-only and excluded from local project scope", async () => {
  const copied = [];
  const remote = row({
    key: "dev01:pi:remote",
    host: "dev01",
    cwd: "/project",
    title: "Remote Pi",
    status: "unknown",
    live: true,
    nativeCommand: "ssh -t build-box 'tmux attach-session -t job'",
  });
  const { view, state } = makeDashboard([remote], {
    copy: async (command) => copied.push(command),
  });
  assert.match(view.render(140).join("\n"), /Pi · dev01/);
  view.handleInput("dev01");
  assert.equal(view.selectedRow().key, remote.key);
  view.handleInput("\r");
  assert.equal(
    state.result,
    null,
    "even a remote Pi sessionFile never becomes a local switch",
  );
  view.handleInput("\x19");
  await tick();
  assert.deepEqual(copied, [remote.nativeCommand]);
  view.handleInput("\x10");
  assert.equal(
    view.selectedRow(),
    undefined,
    "same path text does not mean same host",
  );
  assert.equal(filterRows([remote], 0, "", "/project").length, 0);
});

test("local and remote rows with identical directories get separate project groups", () => {
  const { view } = makeDashboard([
    row({ key: "local", title: "Local task", status: "ready" }),
    row({
      key: "remote",
      host: "dev01",
      title: "Remote task",
      status: "unknown",
    }),
  ]);
  const text = view.render(140).join("\n");
  assert.match(text, /dev01 · \/project/);
  assert.equal(view.selectedRow().key, "local");
});

// Load the real extension through Pi, but never run a model or read credentials.
test("extension registers /agents and removes status on shutdown", async (t) => {
  const h = await harness(t);
  assert.equal(h.current().status, "ready");
  await h.emit("session_shutdown");
  assert.deepEqual(h.registry.list(), []);
});

test("Pi publishes its tmux socket and pane without changing native status", async (t) => {
  const oldTmux = process.env.TMUX;
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX = "/tmp/pi-owner.sock,123,4";
  process.env.TMUX_PANE = "%7";
  t.after(() => {
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
  });
  const h = await harness(t);
  assert.deepEqual(h.current().tmux, {
    socket: "/tmp/pi-owner.sock",
    pane: "%7",
  });
  assert.equal(h.current().status, "ready");
});

test("headless Pi children publish status without claiming inherited tmux panes", async (t) => {
  const oldTmux = process.env.TMUX;
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX = "/tmp/parent-claude.sock,123,4";
  process.env.TMUX_PANE = "%7";
  t.after(() => {
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
  });
  const h = await harness(t);
  for (const mode of ["print", "json", "rpc"]) {
    h.ctx.mode = mode;
    await h.emit("model_select");
    assert.equal(h.current().tmux, undefined, mode);
    assert.equal(h.current().status, "ready", mode);
  }
});

test("run stays Working until agent_settled, including retries", async (t) => {
  const h = await harness(t);
  h.state.busy = true;
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.current().status, "working");
  await h.emit("agent_before_settle", { outcome: "completed" });
  h.state.busy = false;
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.current().status, "ready");
});

test("failure and abort are not reported as completed work", async (t) => {
  const h = await harness(t);
  await h.emit("agent_start");
  await h.emit("agent_before_settle", { outcome: "error" });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.current().status, "error");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.current().status, "stopped");
});

test("blocking UI prompts produce Needs you and restore Working when answered", async (t) => {
  const h = await harness(t);
  h.state.busy = true;
  await h.emit("agent_start");
  await h.emit("ui_prompt_start", {
    kind: "confirm",
    title: "Approve changes?",
  });
  assert.equal(h.current().status, "waiting");
  assert.match(h.current().preview, /Approve changes/);
  await h.emit("ui_prompt_end", { kind: "confirm" });
  assert.equal(h.current().status, "working");
});

test("dashboard is not marked Needs you and is disposed on shutdown", async (t) => {
  const h = await harness(t);
  const command = h.command();
  await h.emit("ui_prompt_start", { kind: "custom" });
  assert.equal(h.current().status, "ready");
  assert.ok(h.state.view);
  await h.emit("session_shutdown");
  await command;
  assert.deepEqual(h.registry.list(), []);
});

test("new-agent UI keeps running work, queued messages and the current draft untouched", async (t) => {
  const h = await harness(t);
  h.state.busy = true;
  h.state.queued = true;
  h.state.draft = "Unsent current task";
  const command = h.command();
  const launches = [],
    opened = [];
  const target = { socket: "/tmp/new-agent.sock", session: "$42", pane: "%7" };
  // Exercise the loaded extension without opening a real terminal.
  h.state.view.opener = async (value) => opened.push(value);
  h.state.view.launcher = async (request) => {
    launches.push(request);
    return {
      message: "Launch accepted. Status not yet confirmed.",
      tmux: target,
    };
  };
  h.state.view.handleInput("\x0e");
  h.state.view.handleInput("\r");
  await tick();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].task, undefined);
  assert.equal(launches[0].terminal, undefined);
  assert.equal(launches[0].cwd, pathKey(h.cwd));
  assert.deepEqual(opened, [target]);
  assert.deepEqual(h.state.switches, []);
  assert.equal(h.state.draft, "Unsent current task");
  assert.equal(h.state.queued, true);
  assert.equal(h.current().status, "working");
  await h.emit("session_shutdown");
  await command;
});

test("opening another agent preserves working state, queued messages and draft", async (t) => {
  const h = await harness(t);
  h.state.busy = true;
  h.state.queued = true;
  h.state.draft = "Keep my draft";
  const command = h.command();
  let finish;
  h.state.view.opener = () =>
    new Promise((done) => {
      finish = done;
    });
  h.state.view.setData([
    row({
      status: "working",
      live: true,
      owners: [record()],
      tmux: { socket: "/tmp/agent.sock", session: "$42", pane: "%7" },
    }),
  ]);
  h.state.view.handleInput("\r");
  await tick();
  await h.emit("message_end", {
    message: { role: "assistant", content: "Parent kept working" },
  });
  assert.equal(h.current().status, "working");
  assert.equal(h.current().preview, "Parent kept working");
  assert.equal(h.state.draft, "Keep my draft");
  assert.equal(h.state.queued, true);
  assert.deepEqual(h.state.switches, []);
  finish();
  await tick();
  h.state.view.handleInput("\x1b");
  await command;
  assert.equal(h.state.confirms, 0);
});

test("loaded dashboard confirms pane closing without switching or interrupting the parent state", async (t) => {
  const h = await harness(t);
  h.state.busy = true;
  h.state.queued = true;
  h.state.draft = "Keep my draft";
  const command = h.command();
  assert.equal(typeof h.state.view.closer, "function");
  const closed = [];
  h.state.view.closer = async (target) => closed.push(target);
  const target = {
    socket: "/tmp/close-other.sock",
    session: "$42",
    pane: "%7",
  };
  h.state.view.setData([
    row({ status: "working", live: true, owners: [record()], tmux: target }),
  ]);
  h.state.view.handleInput("\x18");
  assert.match(h.state.view.render(140).join("\n"), /Close tmux pane\?/);
  assert.deepEqual(closed, []);
  h.state.view.handleInput("\x1b[B");
  h.state.view.handleInput("\r");
  await tick();
  assert.deepEqual(closed, [target]);
  assert.equal(h.state.draft, "Keep my draft");
  assert.equal(h.state.queued, true);
  assert.equal(h.current().status, "working");
  assert.deepEqual(h.state.switches, []);
  assert.equal(h.state.confirms, 0);
  await h.emit("session_shutdown");
  await command;
});

test("extension shutdown aborts the launch helper while the form is pending", async (t) => {
  const h = await harness(t);
  const command = h.command();
  let signal, finish;
  h.state.view.launcher = async (_request, s) => {
    signal = s;
    return new Promise((done) => {
      finish = done;
    });
  };
  h.state.view.handleInput("\x0e");
  for (let i = 0; i < 6; i++) h.state.view.handleInput("\x1b[B");
  h.state.view.handleInput("\r");
  await tick();
  await h.emit("session_shutdown");
  await command;
  assert.equal(signal.aborted, true);
  finish({ message: "late reply" });
  await tick();
  assert.deepEqual(h.registry.list(), []);
  assert.deepEqual(h.state.switches, []);
});

test("message previews and names update without storing tool arguments", async (t) => {
  const h = await harness(t);
  await h.emit("message_end", {
    message: { role: "user", content: "Investigate billing" },
  });
  assert.equal(h.current().title, "Investigate billing");
  await h.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Found it" },
        { type: "toolCall", name: "bash", arguments: { command: "sensitive" } },
      ],
    },
  });
  assert.equal(h.current().preview, "Found it");
  assert.doesNotMatch(
    readFileSync(
      join(
        h.root,
        "agents-status",
        readdirSync(join(h.root, "agents-status"))[0],
      ),
      "utf8",
    ),
    /sensitive/,
  );
});

test("native resume blocks even a stale but living foreign owner", async (t) => {
  const h = await harness(t);
  const other = new Registry(join(h.root, "agents-status"));
  const target = join(h.cwd, "other.jsonl");
  other.write(record({ sessionFile: target }));
  const p = JSON.parse(readFileSync(other.file, "utf8"));
  p.heartbeat -= STALE_MS + 1;
  writeFileSync(other.file, JSON.stringify(p));
  const results = await h.emit("session_before_switch", {
    targetSessionFile: target,
  });
  assert.ok(results.some((result) => result?.cancel));
  other.dispose();
});

test("unconfigured remote keeps local dashboard discovery and launching without remote polling", async (t) => {
  const h = await harness(t);
  const config = join(h.root, "config.json");
  writeFileSync(config, "{}");
  const previous = Object.fromEntries(
    ["PI_EXTENSIONS_CONFIG", "PATH", "CODEX_HOME"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  process.env.PI_EXTENSIONS_CONFIG = config;
  process.env.PATH = bin;
  process.env.CODEX_HOME = h.root;
  process.env.PI_AGENTS_EXTERNAL = "1";
  process.env.PI_AGENTS_DEV01 = "1";
  const calls = join(h.root, "ssh-calls");
  writeFileSync(
    join(bin, "ssh"),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'ssh');process.exit(1);`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify([{ sessionId: "local-fixture", cwd: h.cwd, name: "Local only fixture", kind: "background", status: "idle", pid: process.pid }]))});`,
    { mode: 0o700 },
  );
  const command = h.command();
  try {
    let rendered = "";
    for (let i = 0; i < 100; i++) {
      await new Promise((done) => setTimeout(done, 10));
      rendered = h.state.view.render(180).join("\n");
      if (rendered.includes("Local only fixture")) break;
    }
    assert.match(rendered, /Local only fixture/);
    assert.doesNotMatch(rendered, /dev01 (?:loading|unavailable|\d)/);
    assert.equal(readdirSync(h.root).includes("ssh-calls"), false);
    if (process.platform === "darwin") {
      h.state.view.handleInput("\x0e");
      h.state.view.handleInput("\x1b[C");
      assert.match(
        h.state.view.render(140).join("\n"),
        /Remote launching is disabled/,
      );
      assert.match(h.state.view.render(140).join("\n"), /This Mac/);
      h.state.view.handleInput("\x1b");
    }
  } finally {
    h.state.view.handleInput("\x1b");
    await command;
  }
});

test("dashboard integrates a fake Claude source while Codex is unavailable", async (t) => {
  const h = await harness(t);
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  const oldHome = process.env.CODEX_HOME;
  process.env.PATH = bin;
  process.env.CODEX_HOME = h.root;
  process.env.PI_AGENTS_EXTERNAL = "1";
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
  });
  const fixture = JSON.stringify([
    {
      sessionId: "claude-fixture",
      cwd: h.cwd,
      name: "External fixture",
      kind: "background",
      status: "idle",
      pid: process.pid,
    },
  ]);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nconsole.log(${JSON.stringify(fixture)});\n`,
    { mode: 0o700 },
  );
  const command = h.command();
  let rendered = "";
  for (let i = 0; i < 100; i++) {
    await new Promise((done) => setTimeout(done, 10));
    rendered = h.state.view.render(180).join("\n");
    if (
      rendered.includes("External fixture") &&
      rendered.includes("Codex unavailable")
    )
      break;
  }
  assert.match(rendered, /\[Pi\]/);
  assert.match(rendered, /\[Claude\] External fixture/);
  assert.match(rendered, /Codex unavailable/);
  h.state.view.handleInput("\x0f");
  h.state.view.handleInput("\x0f");
  assert.equal(h.state.view.selectedRow().source, "claude");
  h.state.view.handleInput("\r");
  assert.equal(h.state.confirms, 0);
  assert.deepEqual(h.state.switches, []);
  h.state.view.handleInput("\x1b");
  await command;
});

test("RPC mode reports status but cannot open a terminal dashboard", async (t) => {
  const h = await harness(t);
  h.ctx.mode = "rpc";
  await h.command();
  assert.equal(h.state.view, null);
  assert.match(h.state.notices[0].message, /interactive terminal/);
});

for (const [name, setup] of [
  [
    "running work",
    (state) => {
      state.busy = true;
    },
  ],
  [
    "queued messages",
    (state) => {
      state.queued = true;
    },
  ],
  [
    "unsent draft",
    (state) => {
      state.draft = "Don't lose this";
    },
  ],
]) {
  test(`resume refuses to interrupt ${name}`, async (t) => {
    const h = await harness(t);
    setup(h.state);
    const command = h.command();
    h.state.view.setData([row()]);
    showHistory(h.state.view);
    h.state.view.handleInput("\r");
    await command;
    assert.equal(h.state.confirms, 0);
    assert.deepEqual(h.state.switches, []);
  });
}

test("saved session requires confirmation and rechecks owners afterward", async (t) => {
  const h = await harness(t);
  const other = new Registry(join(h.root, "agents-status"));
  const target = join(h.cwd, "saved.jsonl");
  h.ctx.ui.confirm = async () => {
    other.write(record({ sessionFile: target }));
    return true;
  };
  const command = h.command();
  h.state.view.setData([row({ sessionFile: target })]);
  showHistory(h.state.view);
  h.state.view.handleInput("\r");
  await command;
  assert.deepEqual(h.state.switches, []);
  other.dispose();
});

test("declined confirmation leaves the current session alone", async (t) => {
  const h = await harness(t);
  h.ctx.ui.confirm = async () => false;
  const command = h.command();
  h.state.view.setData([row()]);
  showHistory(h.state.view);
  h.state.view.handleInput("\r");
  await command;
  assert.deepEqual(h.state.switches, []);
});

test("confirmed inactive session delegates switching to Pi", async (t) => {
  const h = await harness(t);
  const target = join(h.cwd, "saved.jsonl");
  writeFileSync(target, "fixture");
  const command = h.command();
  h.state.view.setData([row({ sessionFile: target })]);
  showHistory(h.state.view);
  h.state.view.handleInput("\r");
  await command;
  assert.deepEqual(h.state.switches, [target]);
});

test("a deleted session is not silently recreated when reopened", async (t) => {
  const h = await harness(t);
  const command = h.command();
  h.state.view.setData([row({ sessionFile: join(h.cwd, "missing.jsonl") })]);
  showHistory(h.state.view);
  h.state.view.handleInput("\r");
  await command;
  assert.deepEqual(h.state.switches, []);
  assert.match(h.state.notices.at(-1).message, /Cannot reopen session/);
});

test("work that starts during confirmation prevents switching", async (t) => {
  const h = await harness(t);
  h.ctx.ui.confirm = async () => {
    h.state.busy = true;
    return true;
  };
  const command = h.command();
  h.state.view.setData([row()]);
  showHistory(h.state.view);
  h.state.view.handleInput("\r");
  await command;
  assert.deepEqual(h.state.switches, []);
  assert.match(h.state.notices.at(-1).message, /started working/);
});

test("history refresh loads saved sessions from the current custom directory", async (t) => {
  const h = await harness(t);
  const saved = SessionManager.create(h.cwd, h.manager.getSessionDir());
  saved.appendMessage({
    role: "user",
    content: "History fixture",
    timestamp: Date.now(),
  });
  saved.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Saved answer" }],
    timestamp: Date.now(),
    stopReason: "stop",
  });
  const command = h.command();
  showHistory(h.state.view);
  for (let i = 0; i < 100; i++) {
    await tick();
    if (h.state.view.render(160).join("\n").includes("History fixture")) break;
  }
  assert.match(h.state.view.render(160).join("\n"), /History fixture/);
  h.state.view.handleInput("\t"); // All retains the saved conversation.
  assert.match(h.state.view.render(160).join("\n"), /History fixture/);
  h.state.view.handleInput("\t"); // Sessions hides it again.
  assert.doesNotMatch(h.state.view.render(160).join("\n"), /History fixture/);
  h.state.view.handleInput("\x1b");
  await command;
});
