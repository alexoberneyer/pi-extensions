import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
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
const { assertCloseablePane, closeTmuxPane } = await jiti.import(
  join(source, "close.ts"),
);
const { Dashboard } = await jiti.import(join(source, "dashboard.ts"));
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } =
  await import(pathToFileURL(tuiPath));
const target = { socket: "/tmp/agents-close.sock", session: "$42", pane: "%7" };
const row = {
  source: "tmux",
  key: "job",
  cwd: "/project",
  title: "Worker job",
  preview: "Working",
  model: "",
  status: "unknown",
  updated: 1,
  live: true,
  current: false,
  owners: [],
  tmux: target,
};
const tick = () => new Promise((done) => setImmediate(done));

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-agents-close-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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
function view(closer, rows = [row], keys = getKeybindings()) {
  const calls = { closed: 0, refresh: 0 };
  const terminal = { rows: 30 };
  const dashboard = new Dashboard(
    { terminal, requestRender() {} },
    getThemeByName("dark"),
    keys,
    "/project",
    () => calls.closed++,
    () => calls.refresh++,
    () => {},
    undefined,
    undefined,
    true,
    undefined,
    closer,
  );
  dashboard.setData(rows);
  dashboard.focused = true;
  return { dashboard, calls, terminal };
}
function confirm(dashboard) {
  dashboard.handleInput("\x18"); // Ctrl+X
  dashboard.handleInput("\x1b[B"); // Choose Close, not the default Cancel.
  dashboard.handleInput("\r");
}

test("Ctrl+X shows the exact local target and defaults to Cancel", async () => {
  let closes = 0;
  for (const cancel of ["\r", "\x1b", "\x03"]) {
    const { dashboard, calls } = view(async () => closes++);
    dashboard.handleInput("Worker");
    const before = dashboard.render(140).slice(0, 4);
    dashboard.handleInput("\x18");
    const text = dashboard.render(140).join("\n");
    assert.match(text, /Close tmux pane\?/);
    assert.match(text, /This Mac.*Worker job/);
    assert.match(text, /Project: \/project/);
    assert.match(text, /Session \$42 · Pane %7/);
    assert.match(text, /interrupted/);
    assert.match(text, /Daemon-backed work may keep running/);
    assert.match(text, /→ Cancel/);
    dashboard.handleInput("\x18"); // Repeated shortcut cannot confirm.
    dashboard.handleInput(cancel);
    await tick();
    assert.equal(closes, 0);
    assert.equal(calls.closed, 0);
    assert.equal(calls.refresh, 0);
    assert.equal(dashboard.focused, true);
    assert.deepEqual(dashboard.render(140).slice(0, 4), before);
    assert.match(dashboard.render(140).join("\n"), /Close cancelled/);
  }
});

test("close dialog is centered over the live list without taking the search cursor", () => {
  const { dashboard, terminal } = view(async () => {}, [
    row,
    {
      ...row,
      key: "other",
      title: "Other worker",
      tmux: { ...target, pane: "%8" },
    },
  ]);
  for (const width of [80, 102, 140, 220]) {
    terminal.rows = 30;
    const before = dashboard.render(width).map(stripTerminalSequences);
    dashboard.handleInput("\x18");
    const rendered = dashboard.render(width);
    const lines = rendered.map(stripTerminalSequences);
    const top = lines.findIndex((line) => line.includes("╭"));
    const bottom = lines.findIndex((line) => line.includes("╰"));
    assert.ok(top > 6, "selected row stays visible above the dialog");
    assert.equal(top, Math.floor((terminal.rows - (bottom - top + 1)) / 2));
    const left = lines[top].indexOf("╭");
    const right = lines[top].indexOf("╮");
    assert.equal(left, Math.floor((width - (right - left + 1)) / 2));
    assert.deepEqual(lines.slice(0, 2), before.slice(0, 2));
    assert.ok(lines.some((line) => /›● \[tmux\] Worker job/.test(line)));
    assert.ok(lines.some((line) => /Other worker/.test(line)));
    assert.ok(!rendered.some((line) => line.includes(CURSOR_MARKER)));
    dashboard.handleInput("\x1b");
    assert.ok(dashboard.render(width)[2].includes(CURSOR_MARKER));
  }
});

test("close dialog owns input while the background list keeps receiving status updates", async () => {
  let closes = 0;
  const { dashboard, calls } = view(async () => closes++, [row]);
  dashboard.handleInput("Worker");
  dashboard.render(140);
  dashboard.handleInput("\x18");
  for (const input of ["noise", "\t", "\x0e", "\x10", "\x0f", "\x12"])
    dashboard.handleInput(input);
  dashboard.setData([{ ...row, status: "working" }]);
  const lines = dashboard.render(140).map(stripTerminalSequences);
  assert.match(lines[2], /Search: Worker/);
  assert.ok(lines.some((line) => /›● \[tmux\] Worker job.*Working/.test(line)));
  assert.equal(dashboard.selectedRow().key, row.key);
  assert.equal(calls.refresh, 0);
  dashboard.handleInput("\r");
  await tick();
  assert.equal(closes, 0);
  assert.equal(dashboard.focused, true);
});

test("confirmation closes once, refreshes and preserves search, filters and history metadata", async () => {
  const closed = [];
  let finish;
  const { dashboard, calls } = view(
    (value, signal) => {
      closed.push({ value, signal });
      return new Promise((done) => {
        finish = done;
      });
    },
    [
      {
        ...row,
        source: "pi",
        owners: [{}],
        status: "working",
        sessionFile: "/project/saved.jsonl",
      },
    ],
  );
  dashboard.handleInput("Worker");
  dashboard.handleInput("\t");
  dashboard.handleInput("\t"); // Working filter.
  const before = dashboard.render(140).slice(0, 4);
  confirm(dashboard);
  confirm(dashboard); // Busy input must not issue a second close.
  await tick();
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].value, target);
  assert.equal(calls.closed, 0);
  finish();
  await tick();
  assert.equal(calls.refresh, 1);
  assert.equal(dashboard.selectedRow().sessionFile, "/project/saved.jsonl");
  assert.equal(dashboard.focused, true);
  assert.deepEqual(dashboard.render(140).slice(0, 4), before);
  assert.match(
    dashboard.render(140).join("\n"),
    /Saved history was not deleted/,
  );
});

test("tagged Pi fallback remains closeable, but multiple tracked owners still block it", async () => {
  const fallback = { ...row, source: "pi", tmuxAgent: "pi" };
  const closed = [];
  const { dashboard } = view(async (target) => closed.push(target), [fallback]);
  confirm(dashboard);
  await tick();
  assert.deepEqual(closed, [target]);
  const ambiguous = view(
    async (target) => closed.push(target),
    [{ ...fallback, owners: [{}, {}] }],
  );
  ambiguous.dashboard.handleInput("\x18");
  await tick();
  assert.equal(closed.length, 1);
  assert.match(
    ambiguous.dashboard.render(140).join("\n"),
    /ambiguous ownership/,
  );
});

test("confirmation uses injected navigation, confirm and cancel keys", async () => {
  let closes = 0;
  const keys = {
    matches: (data, action) =>
      ({
        "tui.select.down": "j",
        "tui.select.confirm": "!",
        "tui.select.cancel": "q",
      })[action] === data,
  };
  const { dashboard } = view(async () => closes++, [row], keys);
  dashboard.handleInput("\x18");
  dashboard.handleInput("j");
  dashboard.handleInput("q");
  await tick();
  assert.equal(closes, 0);
  dashboard.handleInput("\x18");
  dashboard.handleInput("j");
  dashboard.handleInput("!");
  await tick();
  assert.equal(closes, 1);
});

test("remote, current, unmapped, ambiguous and session-only rows cannot be closed", async (t) => {
  env(t, "TMUX", `${target.socket},123,0`);
  env(t, "TMUX_PANE", target.pane);
  let closes = 0;
  for (const candidate of [
    { ...row, host: "dev01" },
    { ...row, current: true },
    { ...row, tmux: undefined, nativeCommand: "kill anything" },
    { ...row, source: "pi", owners: [{}, {}] },
    { ...row, source: "pi", owners: [] },
    { ...row, tmux: { ...target, pane: undefined } },
    row, // Even a fallback row cannot close the dashboard's own pane.
  ]) {
    const { dashboard } = view(async () => closes++, [candidate]);
    dashboard.handleInput("\x18");
    await tick();
    assert.match(dashboard.render(140).join("\n"), /Cannot close pane/);
  }
  assert.equal(closes, 0);
});

test("polling cannot redirect confirmation to a different selected row", async () => {
  const closed = [];
  const { dashboard } = view(async (value) => closed.push(value));
  dashboard.handleInput("\x18");
  const other = {
    ...row,
    current: true,
    key: "new",
    tmux: { ...target, pane: "%8" },
  };
  dashboard.setData([other]);
  dashboard.setData([other, row]);
  assert.equal(dashboard.selectedRow().key, "new");
  dashboard.handleInput("\x1b[B");
  dashboard.handleInput("\r");
  await tick();
  assert.deepEqual(closed, [target]);
});

test("removed, remapped or newly protected targets require a fresh confirmation", async () => {
  let closes = 0;
  for (const rows of [
    [],
    [{ ...row, tmux: { ...target, pane: "%8" } }],
    [{ ...row, tmux: { ...target, session: "$43" } }],
    [{ ...row, tmux: { ...target, socket: "/tmp/other.sock" } }],
    [{ ...row, host: "dev01" }],
    [{ ...row, current: true }],
    [{ ...row, source: "pi", owners: [{}, {}] }],
  ]) {
    const { dashboard } = view(async () => closes++);
    dashboard.handleInput("\x18");
    dashboard.setData(rows);
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\r");
    await tick();
    assert.match(dashboard.render(140).join("\n"), /Cannot close pane/);
  }
  assert.equal(closes, 0);
});

test("closing errors stay in the dashboard without retrying, and disposal aborts only the helper", async () => {
  let attempts = 0;
  const failure = view(async () => {
    attempts++;
    throw Error("tmux unavailable");
  });
  confirm(failure.dashboard);
  await tick();
  assert.equal(attempts, 1);
  assert.equal(failure.calls.closed, 0);
  assert.equal(failure.calls.refresh, 1);
  assert.match(
    failure.dashboard.render(140).join("\n"),
    /Refresh before retrying/,
  );
  let signal, finish;
  const pending = view((_target, s) => {
    signal = s;
    return new Promise((done) => {
      finish = done;
    });
  });
  confirm(pending.dashboard);
  await tick();
  pending.dashboard.dispose();
  assert.equal(signal.aborted, true);
  finish();
  await tick();
  assert.equal(pending.calls.refresh, 0);
  const unconfirmed = view(async () => attempts++);
  unconfirmed.dashboard.handleInput("\x18");
  unconfirmed.dashboard.dispose();
  unconfirmed.dashboard.handleInput("\x1b[B");
  unconfirmed.dashboard.handleInput("\r");
  await tick();
  assert.equal(attempts, 1);
});

test("confirmation stays within terminal bounds and refuses closing after an undersized resize", async () => {
  let closes = 0;
  const { dashboard, terminal } = view(
    async () => closes++,
    [{ ...row, title: "中文 🥋 ".repeat(50) }],
  );
  dashboard.handleInput("\x18");
  for (const width of [1, 2, 12, 35, 80, 140]) {
    for (const height of [4, 9, 30]) {
      terminal.rows = height;
      const lines = dashboard.render(width);
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
  terminal.rows = 4;
  dashboard.handleInput("\x1b[B");
  dashboard.handleInput("\r");
  await tick();
  assert.equal(closes, 0);
  terminal.rows = 30;
  assert.match(dashboard.render(140).join("\n"), /Enlarge the terminal/);
});

test("narrow terminals cannot request or confirm a close with a clipped target identity", async () => {
  let closes = 0;
  const narrow = view(async () => closes++);
  narrow.dashboard.render(20);
  narrow.dashboard.handleInput("\x18");
  assert.match(narrow.dashboard.render(140).join("\n"), /Enlarge the terminal/);
  assert.equal(narrow.dashboard.closePrompt, undefined);
  const resized = view(async () => closes++);
  resized.dashboard.render(140);
  resized.dashboard.handleInput("\x18");
  resized.dashboard.render(20);
  resized.dashboard.handleInput("\x1b[B");
  resized.dashboard.handleInput("\r");
  await tick();
  assert.equal(closes, 0);
  assert.match(
    resized.dashboard.render(140).join("\n"),
    /Enlarge the terminal/,
  );
  const beforeRender = view(async () => closes++);
  beforeRender.terminal.columns = 20;
  beforeRender.dashboard.handleInput("\x18");
  assert.equal(beforeRender.dashboard.closePrompt, undefined);
  assert.equal(closes, 0);
});

test("a short resize cannot hide warnings or options and still permit closing", async () => {
  let closes = 0;
  const { dashboard, terminal } = view(async () => closes++);
  dashboard.render(140);
  dashboard.handleInput("\x18");
  dashboard.handleInput("\x1b[B");
  terminal.rows = 12;
  const text = dashboard.render(140).join("\n");
  assert.match(text, /Enlarge the terminal/);
  assert.doesNotMatch(text, /→ Close tmux pane/);
  dashboard.handleInput("\r");
  await tick();
  assert.equal(closes, 0);
  terminal.rows = 30;
  assert.equal(dashboard.closePrompt, undefined);
  assert.match(dashboard.render(140).join("\n"), /Enlarge the terminal/);
});

test("pane validation rejects invalid targets, socket aliases of self and unverifiable dashboard identity", (t) => {
  env(t, "TMUX", undefined);
  env(t, "TMUX_PANE", undefined);
  for (const change of [
    { socket: "relative" },
    { socket: "/tmp/bad\npath" },
    { session: "$42;kill-server" },
    { pane: "%7;kill-server" },
    { pane: undefined },
  ])
    assert.throws(() => assertCloseablePane({ ...target, ...change }));
  const root = temporary(t);
  const original = join(root, "socket");
  const alias = join(root, "alias");
  writeFileSync(original, "");
  symlinkSync(original, alias);
  env(t, "TMUX", `${original},123,0`);
  env(t, "TMUX_PANE", target.pane);
  assert.throws(
    () => assertCloseablePane({ ...target, socket: alias }),
    /containing this dashboard/,
  );
  assert.doesNotThrow(() => assertCloseablePane(target)); // Same pane ID on another socket is not self.
  process.env.TMUX = "malformed";
  assert.throws(() => assertCloseablePane(target), /Cannot verify/);
});

function fakeTmux(t, mode = "ok") {
  const root = temporary(t);
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "tmux"),
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n'); ${mode === "moved" ? "console.log('Pane moved or exited. Refresh /agents.');" : mode === "fail" ? "process.exit(3);" : ""}`,
    { mode: 0o700 },
  );
  env(t, "PATH", bin);
  env(t, "TMUX", undefined);
  env(t, "TMUX_PANE", undefined);
  return () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
}

test("close dispatches one shell-free, session-checked kill-pane command", async (t) => {
  const calls = fakeTmux(t);
  await closeTmuxPane(target, new AbortController().signal);
  assert.deepEqual(calls(), [
    [
      "-S",
      target.socket,
      "if-shell",
      "-F",
      "-t",
      target.pane,
      "#{==:#{session_id},$42}",
      "kill-pane -t %7",
      'display-message -p "Pane moved or exited. Refresh /agents."',
    ],
  ]);
});

for (const mode of ["moved", "fail"])
  test(`close reports ${mode} without retrying`, async (t) => {
    const calls = fakeTmux(t, mode);
    await assert.rejects(closeTmuxPane(target, new AbortController().signal));
    assert.equal(calls().length, 1);
  });

test("invalid, self and aborted requests never invoke tmux", async (t) => {
  const calls = fakeTmux(t);
  await assert.rejects(
    closeTmuxPane({ ...target, pane: undefined }, new AbortController().signal),
  );
  env(t, "TMUX", `${target.socket},123,0`);
  env(t, "TMUX_PANE", target.pane);
  await assert.rejects(
    closeTmuxPane(target, new AbortController().signal),
    /containing this dashboard/,
  );
  process.env.TMUX_PANE = "%8";
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(closeTmuxPane(target, controller.signal));
  assert.deepEqual(calls(), []);
});

const realTmux = spawnSync("which", ["tmux"], {
  encoding: "utf8",
}).stdout?.trim();
function realFixture(t) {
  const root = temporary(t);
  const socket = join(root, "s");
  env(t, "TMUX", undefined);
  env(t, "TMUX_PANE", undefined);
  const run = (...args) =>
    execFileSync(realTmux, ["-S", socket, ...args], {
      encoding: "utf8",
    }).trim();
  run(
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "job",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  );
  t.after(() => spawnSync(realTmux, ["-S", socket, "kill-server"]));
  const [session, pane] = run(
    "display-message",
    "-p",
    "-t",
    "job",
    "#{session_id}\t#{pane_id}",
  ).split("\t");
  const other = run(
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    pane,
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  );
  return { root, run, other, target: { socket, session, pane } };
}

test(
  "real tmux closes only the confirmed pane and preserves its sibling and saved history",
  { skip: !realTmux },
  async (t) => {
    const fixture = realFixture(t);
    const history = join(fixture.root, "history.jsonl");
    writeFileSync(history, "saved conversation\n");
    const { dashboard, calls } = view(closeTmuxPane, [
      { ...row, tmux: fixture.target, sessionFile: history },
    ]);
    confirm(dashboard);
    for (let i = 0; i < 100 && !calls.refresh; i++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(calls.refresh, 1);
    assert.match(dashboard.render(140).join("\n"), /Tmux pane closed/);
    assert.equal(
      fixture.run(
        "list-panes",
        "-t",
        fixture.target.session,
        "-F",
        "#{pane_id}",
      ),
      fixture.other,
    );
    assert.equal(readFileSync(history, "utf8"), "saved conversation\n");
  },
);

const python = "/usr/bin/python3";
for (const mode of ["regular", "fullscreen"])
  test(
    `real Pi PTY ${mode} scopes Ctrl+X to the dashboard and closes only after confirmation`,
    {
      skip: !realTmux || spawnSync(python, ["--version"]).status !== 0,
      timeout: 20_000,
    },
    async (t) => {
      const fixture = realFixture(t);
      const bin = join(fixture.root, "bin");
      mkdirSync(bin);
      const pane = [
        fixture.target.socket,
        fixture.target.session,
        fixture.target.pane,
        "0",
        fixture.root,
        "worker",
        "pi",
        fixture.run(
          "display-message",
          "-p",
          "-t",
          fixture.target.pane,
          "#{pane_pid}",
        ),
      ].join("\t");
      // Discovery is isolated: no user sessions, Claude processes, daemon or SSH.
      writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}\nconsole.log('[]');`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "tmux"),
        `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes('list-panes')) console.log(${JSON.stringify(pane)}); else { const r = require('node:child_process').spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); }`,
        { mode: 0o700 },
      );
      const script = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 160, 0, 0))
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
os.close(slave)
data = b''
def wait_for(marker):
    global data
    end = time.time() + 6
    while marker not in data:
        if time.time() > end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-2000:]))
        if select.select([master], [], [], .1)[0]: data += os.read(master, 65536)
try:
    wait_for(b'Warning: No models available.')
    data = b''
    os.write(master, b'\\x18')
    wait_for(b'No agent messages to copy yet.')
    data = b''
    os.write(master, b'/agents\\r')
    wait_for(b'^X close pane')
    os.write(master, b'worker')
    wait_for(b'[Pi] Pi in')
    data = b''
    os.write(master, b'\\x18')
    wait_for(b'Close tmux pane?')
    wait_for(b'Cancel')
    data = b''
    os.write(master, b'\\r')
    wait_for(b'Close cancelled.')
    data = b''
    os.write(master, b'\\x18')
    wait_for(b'Close tmux pane?')
    data = b''
    os.write(master, b'\\x1b[B\\r')
    wait_for(b'Tmux pane closed.')
    data = b''
    os.write(master, b'\\x1b')
    wait_for(b'Search:')
    data = b''
    os.write(master, b'\\x1b')
    time.sleep(.15)
    os.write(master, b'\\x18')
    wait_for(b'No agent messages to copy yet.')
    os.write(master, b'\\x04')
    end = time.time() + 3
    while p.poll() is None and time.time() < end:
        if select.select([master], [], [], .05)[0]:
            try: data += os.read(master, 65536)
            except OSError: break
    p.wait(timeout=3)
    print(json.dumps({'exit': p.returncode, 'closed': True}))
finally:
    if p.poll() is None:
        p.kill()
        p.wait()
    os.close(master)
`;
      const output = execFileSync(
        python,
        [
          "-c",
          script,
          process.execPath,
          join(packageDir, "dist/cli.js"),
          "--offline",
          "--no-extensions",
          "--extension",
          join(source, "index.ts"),
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tui-mode",
          mode,
        ],
        {
          cwd: fixture.root,
          encoding: "utf8",
          timeout: 18_000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TERM: "xterm-256color",
            TMUX: "",
            TMUX_PANE: "",
            PI_CODING_AGENT_DIR: join(fixture.root, "pi"),
            PI_CODING_AGENT_SESSION_DIR: join(fixture.root, "sessions"),
            PI_AGENTS_EXTERNAL: "1",
            PI_AGENTS_DEV01: "0",
            CODEX_HOME: fixture.root,
          },
        },
      );
      assert.deepEqual(JSON.parse(output), { exit: 0, closed: true });
      assert.equal(
        fixture.run(
          "list-panes",
          "-t",
          fixture.target.session,
          "-F",
          "#{pane_id}",
        ),
        fixture.other,
      );
    },
  );

test(
  "real tmux refuses a pane moved to another session or removed before closing",
  { skip: !realTmux },
  async (t) => {
    const fixture = realFixture(t);
    fixture.run(
      "new-session",
      "-d",
      "-s",
      "other",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    );
    fixture.run("move-pane", "-s", fixture.target.pane, "-t", "other");
    await assert.rejects(
      closeTmuxPane(fixture.target, new AbortController().signal),
      /moved or exited/,
    );
    assert.equal(
      fixture.run(
        "display-message",
        "-p",
        "-t",
        fixture.target.pane,
        "#{pane_id}",
      ),
      fixture.target.pane,
    );
    fixture.run("kill-pane", "-t", fixture.target.pane);
    await assert.rejects(
      closeTmuxPane(fixture.target, new AbortController().signal),
    );
    assert.equal(
      fixture.run(
        "list-panes",
        "-t",
        fixture.target.session,
        "-F",
        "#{pane_id}",
      ),
      fixture.other,
    );
  },
);
