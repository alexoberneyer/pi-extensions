import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { GHOSTTY_SCRIPT, launchLocal } from "../bin/agent-launch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realTmux = spawnSync("which", ["tmux"], {
  encoding: "utf8",
}).stdout?.trim();
const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const tuiPath = require.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
    "@earendil-works/pi-tui": tuiPath,
  },
});
const { Dashboard } = await jiti.import(
  join(root, "extensions/agents/dashboard.ts"),
);
const { localTmuxRows, PANE_FORMAT } = await jiti.import(
  join(root, "extensions/agents/local-tmux.ts"),
);
const { LaunchForm } = await jiti.import(
  join(root, "extensions/agents/launch-form.ts"),
);
const { validateLaunch, localProject, launchAgent } = await jiti.import(
  join(root, "extensions/agents/launch.ts"),
);
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const {
  getKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  CURSOR_MARKER,
  stripTerminalSequences,
} = await import(pathToFileURL(tuiPath));
const theme = getThemeByName("dark");
const keys = getKeybindings();
const tick = () => new Promise((done) => setImmediate(done));
const down = "\x1b[B",
  up = "\x1b[A",
  left = "\x1b[D",
  right = "\x1b[C",
  tab = "\t",
  shiftTab = "\x1b[Z",
  enter = "\r",
  esc = "\x1b";
const paste = (text) => `\x1b[200~${text}\x1b[201~`;
function move(view, n) {
  for (let i = 0; i < Math.abs(n); i++) view.handleInput(n > 0 ? down : up);
}
function editProject(view, value) {
  view.handleInput("\x01");
  view.handleInput("\x0b");
  view.handleInput(paste(value));
}
function selectedField(view) {
  return view
    .render(120)
    .map(stripTerminalSequences)
    .find((line) => /^› (Host|Agent|Project)\b/.test(line))
    ?.match(/^› (\w+)/)[1];
}
function cursorCount(lines) {
  return lines.join("\n").split(CURSOR_MARKER).length - 1;
}
test.beforeEach((t) => {
  const config = join(temporary(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      remote: { host: "build-box", project: "~/work/project" },
    }),
  );
  env(t, "PI_EXTENSIONS_CONFIG", config);
});

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "agents-launch-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function env(t, key, value) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
function form(remote = true, bindings = keys) {
  const results = [];
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const view = new LaunchForm(
    tui,
    theme,
    bindings,
    "/local/project",
    remote,
    (value) => results.push(value),
  );
  view.focused = true;
  return { view, results, tui };
}
const row = {
  source: "pi",
  key: "here",
  current: true,
  cwd: "/local/project",
  title: "Keep me",
  preview: "",
  owners: [],
  status: "working",
  updated: 1,
  live: true,
};
function dashboard(
  launcher,
  { copyCommand, opener, remoteLaunch = true } = {},
) {
  const calls = { closed: 0, refresh: 0, cleanup: 0, opened: [] };
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const view = new Dashboard(
    tui,
    theme,
    keys,
    "/local/project",
    () => calls.closed++,
    () => calls.refresh++,
    () => calls.cleanup++,
    copyCommand,
    launcher,
    remoteLaunch,
    (target, signal) => {
      calls.opened.push({ target, signal });
      return opener ? opener(target, signal) : Promise.resolve("detached");
    },
  );
  view.setData([row]);
  view.focused = true;
  return { view, calls, tui };
}

test("form has only Host, Agent and Project with a generated private job name", () => {
  const { view, results } = form();
  const output = view.render(100, 7).map(stripTerminalSequences).join("\n");
  assert.match(output, /Host\s+‹ This Mac ›/);
  assert.match(output, /Agent\s+‹ pi ›/);
  assert.match(output, /Project\s+\/local\/project/);
  assert.doesNotMatch(output, /Terminal|Job name|Task|Start|Cancel|Ghostty/);
  assert.deepEqual(results, []);
  assert.equal(cursorCount(view.render(100, 7)), 0);
  view.handleInput(enter);
  assert.deepEqual(
    { ...results[0], name: "generated" },
    { host: "local", agent: "pi", cwd: "/local/project", name: "generated" },
  );
  assert.match(results[0].name, /^job-[a-f0-9]{8}$/);
});

for (const [index, field] of ["Host", "Agent", "Project"].entries()) {
  test(`Enter from ${field} launches once and repeated Enter stays pending`, () => {
    const { view, results } = form();
    move(view, index);
    assert.equal(selectedField(view), field);
    view.handleInput(enter);
    view.handleInput(enter);
    view.handleInput(enter);
    view.handleInput(right);
    view.handleInput(tab);
    assert.equal(results.length, 1);
    assert.equal(results[0].agent, "pi");
    assert.equal(results[0].host, "local");
    assert.match(view.render(100, 7).join("\n"), /Launching/);
    assert.equal(cursorCount(view.render(100, 7)), 0);
  });

  test(`one Escape from ${field} cancels the entire form without launching`, () => {
    const { view, results } = form();
    move(view, index);
    if (field === "Project") editProject(view, "unsaved-inline-project");
    view.handleInput(esc);
    view.handleInput(esc);
    view.handleInput(enter);
    assert.deepEqual(results, [undefined]);
  });
}

for (const [key, expected] of [
  [tab, ["Agent", "Project", "Host"]],
  [down, ["Agent", "Project", "Host"]],
  [shiftTab, ["Project", "Agent", "Host"]],
  [up, ["Project", "Agent", "Host"]],
])
  test(`field navigation ${JSON.stringify(key)} wraps across exactly three rows`, () => {
    const { view, results } = form();
    for (const field of [...expected, ...expected]) {
      view.handleInput(key);
      assert.equal(selectedField(view), field);
    }
    assert.deepEqual(results, []);
  });

for (const key of [left, right])
  test(`${JSON.stringify(key)} cycles hosts and all agents without launching`, () => {
    const { view, results } = form();
    view.handleInput(key);
    assert.match(view.render(100).join("\n"), /Host\s+‹ dev01 ›/);
    assert.match(view.render(100).join("\n"), /~\/work\/project/);
    view.handleInput(key);
    assert.match(view.render(100).join("\n"), /Host\s+‹ This Mac ›/);
    move(view, 1);
    for (const agent of key === right
      ? ["claude", "codex", "pi"]
      : ["codex", "claude", "pi"]) {
      view.handleInput(key);
      assert.match(
        view.render(100).join("\n"),
        new RegExp(`Agent\\s+‹ ${agent} ›`),
      );
    }
    assert.deepEqual(results, []);
  });

test("inline Project accepts edits immediately and Enter launches instead of opening an editor", () => {
  const { view, results } = form();
  move(view, 2);
  editProject(view, "../O'Brien");
  assert.deepEqual(results, []);
  assert.match(view.render(100).join("\n"), /\.\.\/O'Brien/);
  assert.equal(cursorCount(view.render(100)), 1);
  view.handleInput(left);
  view.handleInput("X");
  view.handleInput(enter);
  assert.equal(results[0].cwd, "/local/O'BrieXn");
  assert.equal(results.length, 1);
});

for (const remoteProject of [
  "~",
  "~/Code/other",
  "relative/project",
  "/home/remote/project",
]) {
  for (const host of ["local", "dev01"])
    test(`${host} launch preserves each host's raw Project across toggles: ${remoteProject}`, () => {
      const { view, results } = form();
      move(view, 2);
      editProject(view, "../O'Brien");
      move(view, 1);
      view.handleInput(right);
      move(view, 2);
      editProject(view, remoteProject);
      move(view, 1);
      view.handleInput(left);
      assert.match(view.render(100).join("\n"), /\.\.\/O'Brien/);
      if (host === "dev01") {
        view.handleInput(right);
        assert.ok(view.render(100).join("\n").includes(remoteProject));
      }
      view.handleInput(enter);
      assert.equal(results[0].host, host);
      assert.equal(
        results[0].cwd,
        host === "local" ? "/local/O'Brien" : remoteProject,
      );
    });
}

test("local Project expands home and resolves relative paths against the initial cwd", () => {
  assert.equal(localProject("../other", "/local/project"), "/local/other");
  assert.equal(
    localProject("~/code", "/project"),
    join(process.env.HOME, "code"),
  );
  assert.equal(localProject("~", "/project"), process.env.HOME);
});

test("disabled discovery blocks both host directions but still permits a local launch", () => {
  const { view, results } = form(false);
  for (const key of [left, right]) {
    view.handleInput(key);
    assert.match(view.render(120).join("\n"), /Remote launching is disabled/);
    assert.match(view.render(120).join("\n"), /Host\s+‹ This Mac ›/);
  }
  view.handleInput(enter);
  assert.equal(results[0].host, "local");
});

test("empty Project validates inline, keeps focus and permits correction", () => {
  const { view, results } = form();
  move(view, 2);
  editProject(view, "   ");
  view.handleInput(enter);
  assert.deepEqual(results, []);
  assert.match(view.render(100).join("\n"), /Project cannot be empty/);
  assert.equal(cursorCount(view.render(100)), 1);
  editProject(view, "../fixed");
  view.handleInput(enter);
  assert.equal(results[0].cwd, "/local/fixed");
});

test("only a selected and focused Project Input owns the cursor marker", () => {
  const { view } = form();
  assert.equal(cursorCount(view.render(100)), 0);
  move(view, 1);
  assert.equal(cursorCount(view.render(100)), 0);
  move(view, 1);
  assert.equal(cursorCount(view.render(100)), 1);
  view.focused = false;
  assert.equal(cursorCount(view.render(100)), 0);
  view.focused = true;
  view.invalidate();
  assert.equal(cursorCount(view.render(100)), 1);
  view.reportOpening();
  assert.equal(cursorCount(view.render(100)), 0);
  view.reportFailure("Cannot launch");
  assert.equal(cursorCount(view.render(100)), 0);
});

test("custom confirm, cancel and field-navigation bindings are respected", () => {
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "ctrl+j",
    "tui.select.cancel": "ctrl+q",
    "tui.select.down": "ctrl+f",
    "tui.select.up": "ctrl+b",
  });
  const { view, results } = form(true, bindings);
  view.handleInput(enter);
  assert.deepEqual(results, []);
  view.handleInput("\x06");
  assert.equal(selectedField(view), "Agent");
  view.handleInput("\x02");
  assert.equal(selectedField(view), "Host");
  view.handleInput("\x0a");
  assert.equal(results.length, 1);
  const cancelled = form(true, bindings);
  cancelled.view.handleInput("\x11");
  assert.deepEqual(cancelled.results, [undefined]);
});

test("disposing a form prevents subsequent launch and cancellation callbacks", () => {
  const { view, results } = form();
  view.dispose();
  view.handleInput(enter);
  view.handleInput(esc);
  assert.deepEqual(results, []);
});

test("cancelling the launch form preserves dashboard search, filters and selection", () => {
  const { view, calls } = dashboard(async () => {
    throw Error("must not launch");
  });
  view.handleInput("Keep");
  view.handleInput("\t");
  view.handleInput("\t");
  const before = view.render(120).join("\n");
  view.handleInput("\x0e");
  assert.match(view.render(120).join("\n"), /New agent/);
  view.handleInput(esc);
  assert.equal(view.render(120).join("\n"), before);
  assert.equal(view.selectedRow().key, "here");
  assert.equal(view.focused, true);
  assert.equal(calls.closed, 0);
});

test("new-agent popup is centered over a subdued live dashboard and restores search focus", () => {
  const { view, tui } = dashboard(async () => {
    throw Error("must not launch");
  });
  for (const width of [80, 102, 140, 220]) {
    const before = view.render(width);
    view.handleInput("\x0e");
    const rendered = view.render(width);
    const lines = rendered.map(stripTerminalSequences);
    const top = lines.findIndex((line) => line.includes("╭"));
    const bottom = lines.findIndex((line) => line.includes("╰"));
    assert.ok(top > 6, "selected agent remains visible above the popup");
    assert.equal(top, Math.floor((tui.terminal.rows - (bottom - top + 1)) / 2));
    const left = lines[top].indexOf("╭");
    const right = lines[top].indexOf("╮");
    assert.equal(left, Math.floor((width - (right - left + 1)) / 2));
    assert.equal(right - left + 1, Math.min(72, width - 4));
    assert.equal(bottom - top + 1, 9, "seven form lines plus two border lines");
    assert.equal(
      rendered[0],
      theme.fg("dim", stripTerminalSequences(before[0])),
    );
    assert.match(lines[6], /Keep me.*Working/);
    assert.match(lines.join("\n"), /New agent/);
    assert.match(lines.join("\n"), /Enter launch/);
    assert.doesNotMatch(lines.join("\n"), /Terminal|Job name|Task|Start/);
    assert.ok(!rendered.some((line) => line.includes(CURSOR_MARKER)));
    assert.ok(rendered.every((line) => visibleWidth(line) === width));
    view.handleInput(esc);
    assert.deepEqual(view.render(width), before);
    assert.ok(view.render(width)[2].includes(CURSOR_MARKER));
  }
});

test("new-agent popup owns input while the background keeps receiving status updates", () => {
  const { view, calls } = dashboard(async () => {
    throw Error("must not launch");
  });
  view.handleInput("Keep");
  view.handleInput("\x0e");
  for (const input of ["noise", "\t", "\x18", "\x0e", "\x10", "\x0f", "\x12"])
    view.handleInput(input);
  view.setData([{ ...row, status: "ready" }]);
  const lines = view.render(140).map(stripTerminalSequences);
  assert.match(lines[2], /Search: Keep/);
  assert.match(lines[6], /Keep me.*Idle/);
  assert.equal(view.selectedRow().key, "here");
  assert.equal(calls.refresh, 0);
  view.handleInput(esc);
  assert.equal(view.focused, true);
  assert.match(view.render(140).map(stripTerminalSequences)[2], /Search: Keep/);
});

test("Project edits stay inline inside the compact popup, and one Escape restores search", () => {
  const requests = [];
  const { view, tui } = dashboard(async (request) => requests.push(request));
  view.handleInput("Keep");
  const before = view.render(120);
  view.handleInput("\x0e");
  move(view, 2);
  const project = "../" + "中文 🥋 ".repeat(30) + "PROJECT-END";
  editProject(view, project);
  let lines = view.render(120);
  assert.match(lines.join("\n"), /New agent/);
  assert.doesNotMatch(lines.join("\n"), /New agent · cwd|New agent · task/);
  assert.match(lines.join("\n"), /PROJECT-END/);
  assert.ok(lines.some((line) => line.includes("╭")));
  assert.equal(cursorCount(lines), 1);
  tui.terminal.rows = 8;
  lines = view.render(60);
  assert.match(lines.join("\n"), /PROJECT-END/);
  assert.equal(cursorCount(lines), 1);
  tui.terminal.rows = 30;
  assert.ok(view.render(120).some((line) => line.includes("╭")));
  assert.deepEqual(requests, []);
  view.handleInput(esc);
  assert.deepEqual(view.render(120), before);
  assert.equal(view.selectedRow().key, "here");
  assert.equal(view.focused, true);
});

test("compact popup switches at 64 columns and 11 rows and preserves the Project cursor on resize", () => {
  const { view, tui } = dashboard(async () => {
    throw Error("must not launch");
  });
  view.handleInput("\x0e");
  move(view, 2);
  editProject(view, "../" + "中文 🥋".repeat(20) + "PROJECT-END");
  for (const width of [1, 2, 12, 20, 40, 63, 64, 65, 75, 76, 80, 120]) {
    for (const height of [3, 4, 8, 9, 10, 11, 12, 30]) {
      tui.terminal.rows = height;
      const lines = view.render(width);
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(
        lines.some((line) => line.includes("╭")),
        width >= 64 && height >= 11,
        `wrong layout at ${width}x${height}`,
      );
      assert.ok(
        cursorCount(lines) <= 1,
        `duplicate cursor at ${width}x${height}`,
      );
      if (width >= 20)
        assert.equal(
          cursorCount(lines),
          1,
          `missing cursor at ${width}x${height}`,
        );
    }
  }
  tui.terminal.rows = 30;
  assert.match(view.render(120).join("\n"), /PROJECT-END/);
  assert.equal(view.focused, true);
});

test("a very narrow terminal preserves the selected Project cursor instead of clipping it with the label", () => {
  const standalone = form();
  move(standalone.view, 2);
  editProject(standalone.view, "../long-project-name");
  assert.equal(
    cursorCount(standalone.view.render(12, 4)),
    1,
    "form cursor at 12x4",
  );
  const popup = dashboard(async () => {
    throw Error("must not launch");
  });
  popup.view.handleInput("\x0e");
  move(popup.view, 2);
  editProject(popup.view, "../long-project-name");
  popup.tui.terminal.rows = 4;
  assert.equal(
    cursorCount(popup.view.render(12)),
    1,
    "dashboard cursor at 12x4",
  );
});

for (const mode of ["regular", "fullscreen"])
  test(
    `real Pi PTY ${mode} edits and cancels the new-agent popup without launching`,
    {
      skip:
        process.platform !== "darwin" ||
        spawnSync("/usr/bin/python3", ["--version"]).status !== 0,
      timeout: 20_000,
    },
    (t) => {
      const home = temporary(t);
      const bin = join(home, "bin");
      const launched = join(home, "unexpected-launch");
      mkdirSync(bin);
      for (const executable of ["pi", "claude", "codex", "tmux", "osascript"])
        writeFileSync(
          join(bin, executable),
          `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launched)}, ${JSON.stringify(executable + "\n")}); process.exit(99);`,
          { mode: 0o700 },
        );
      const script = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct, signal
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
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
    os.write(master, b'/agents\\r')
    wait_for(b'^N new agent')
    os.write(master, b'popup-probe')
    wait_for(b'popup-probe')
    data = b''
    os.write(master, b'\\x0e')
    wait_for(b'New agent')
    wait_for('╭'.encode())
    data = b''
    os.write(master, b'\\t\\t')
    wait_for('› Project'.encode())
    data = b''
    os.write(master, b'\\x01\\x0b\\x1b[200~../inline-project-PROJECT-END\\x1b[201~')
    wait_for(b'PROJECT-END')
    data = b''
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 8, 60, 0, 0))
    os.kill(p.pid, signal.SIGWINCH)
    wait_for(b'PROJECT-END')
    data = b''
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    os.kill(p.pid, signal.SIGWINCH)
    wait_for('╭'.encode())
    wait_for(b'PROJECT-END')
    data = b''
    os.write(master, b'\\x1b')
    wait_for(b'popup-probe')
    data = b''
    os.write(master, b'\\x03')
    wait_for(b'[here]')
    data = b''
    os.write(master, b'\\r')
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
    print(json.dumps({'exit': p.returncode, 'cancelled': True}))
finally:
    if p.poll() is None: p.kill()
    os.close(master)
    p.wait(timeout=3)
`;
      const output = execFileSync(
        "/usr/bin/python3",
        [
          "-c",
          script,
          process.execPath,
          join(packageDir, "dist/cli.js"),
          "--offline",
          "--no-extensions",
          "--extension",
          join(root, "extensions/agents/index.ts"),
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tui-mode",
          mode,
        ],
        {
          cwd: home,
          encoding: "utf8",
          timeout: 18_000,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            PI_CODING_AGENT_DIR: join(home, "pi"),
            PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
            PI_AGENTS_EXTERNAL: "0",
            PATH: `${bin}:${process.env.PATH}`,
            TMUX: "",
            TMUX_PANE: "",
          },
        },
      );
      assert.deepEqual(JSON.parse(output), { exit: 0, cancelled: true });
      assert.equal(
        existsSync(launched),
        false,
        "editing and Escape must never launch",
      );
    },
  );

test("launch automatically opens its target, remains pending during opening and returns without a success screen", async () => {
  const requests = [],
    copied = [];
  const target = { socket: "/tmp/launched.sock", session: "$42" };
  let finishLaunch, finishOpen;
  const { view, calls } = dashboard(
    (request) => {
      requests.push(request);
      return new Promise((done) => {
        finishLaunch = done;
      });
    },
    {
      copyCommand: async (command) => copied.push(command),
      opener: () =>
        new Promise((done) => {
          finishOpen = done;
        }),
    },
  );
  view.handleInput("Keep");
  view.handleInput(tab);
  view.handleInput(tab);
  const before = view.render(140).slice(0, 4);
  view.handleInput("\x0e");
  view.handleInput(enter);
  view.handleInput(enter);
  await tick();
  assert.equal(requests.length, 1);
  assert.match(view.render(100).join("\n"), /Launching/);
  assert.deepEqual(calls.opened, []);
  finishLaunch({
    message: "LAUNCH-SUCCESS-PANEL",
    attachCommand: "COPY-SENTINEL",
    tmux: target,
  });
  await tick();
  assert.equal(calls.refresh, 1);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].target, target);
  let output = view.render(140).join("\n");
  assert.match(output, /New agent/);
  assert.match(output, /Opening agent/);
  assert.doesNotMatch(
    output,
    /LAUNCH-SUCCESS-PANEL|COPY-SENTINEL|Enter opens|Attach in another terminal/,
  );
  view.handleInput(enter);
  view.handleInput("\x19");
  view.handleInput("\x0e");
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(calls.opened.length, 1);
  assert.deepEqual(copied, []);
  finishOpen("detached");
  await tick();
  assert.equal(calls.refresh, 2);
  assert.equal(calls.closed, 0);
  assert.equal(view.selectedRow().key, "here");
  assert.equal(view.focused, true);
  assert.deepEqual(view.render(140).slice(0, 4), before);
  output = view.render(140).join("\n");
  assert.doesNotMatch(output, /New agent|LAUNCH-SUCCESS-PANEL|COPY-SENTINEL/);
  assert.match(output, /Returned to Agents/);
});

for (const acknowledge of [enter, esc])
  test(`launch failure keeps fields inline and ${JSON.stringify(acknowledge)} returns without retrying`, async () => {
    let launches = 0;
    const { view, calls } = dashboard(async () => {
      launches++;
      throw Error("SSH reply lost. Check before retrying.");
    });
    view.handleInput("\x0e");
    view.handleInput(enter);
    await tick();
    let output = view.render(140).join("\n");
    assert.match(output, /SSH reply lost/);
    assert.match(output, /Host\s+‹ This Mac ›/);
    assert.match(output, /Agent\s+‹ pi ›/);
    assert.match(output, /Project\s+\/local\/project/);
    assert.equal(cursorCount(view.render(140)), 0);
    view.setData([row]);
    assert.match(view.render(140).join("\n"), /SSH reply lost/);
    view.handleInput(acknowledge);
    await tick();
    output = view.render(140).join("\n");
    assert.doesNotMatch(output, /New agent/);
    assert.equal(launches, 1);
    assert.deepEqual(calls.opened, []);
    assert.equal(calls.closed, 0);
    assert.equal(view.focused, true);
  });

test("long launch errors are scrollable and acknowledging them cannot retry", async () => {
  let launches = 0;
  const { view, calls, tui } = dashboard(async () => {
    launches++;
    throw Error(`${"Details ".repeat(180)} HANDOFF-END`);
  });
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  tui.terminal.rows = 8;
  assert.match(view.render(60).join("\n"), /launch failed/);
  move(view, 100);
  assert.match(view.render(60).join("\n"), /HANDOFF-END/);
  move(view, -100);
  assert.match(view.render(60).join("\n"), /Host\s+‹ This Mac ›/);
  view.handleInput(enter);
  assert.equal(view.selectedRow().key, "here");
  assert.equal(calls.closed, 0);
  assert.equal(launches, 1);
});

for (const action of ["cancel", "dispose"]) {
  test(`${action} aborts only the pending launch helper and ignores its late reply`, async () => {
    let signal, finish;
    const { view, calls } = dashboard((_request, s) => {
      signal = s;
      return new Promise((done) => {
        finish = done;
      });
    });
    view.handleInput("\x0e");
    view.handleInput(enter);
    await tick();
    if (action === "cancel") view.handleInput(esc);
    else view.dispose();
    assert.equal(signal.aborted, true);
    finish({
      message: "Late success",
      tmux: { socket: "/tmp/late.sock", session: "$99" },
    });
    await tick();
    assert.equal(calls.refresh, 0);
    assert.deepEqual(calls.opened, []);
    if (action === "cancel")
      assert.match(view.render(120).join("\n"), /may have started/);
    else assert.equal(calls.cleanup, 1);
  });
}

test("form clips short terminals, scrolls Project horizontally and preserves its draft and cursor", () => {
  const { view, results, tui } = form();
  move(view, 2);
  const project = "../" + "中文 🥋".repeat(40) + "PROJECT-END";
  editProject(view, project);
  for (const width of [1, 2, 20, 40, 100]) {
    for (const height of [1, 2, 3, 4, 8, 12, 30]) {
      tui.terminal.rows = height;
      const lines = view.render(width);
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(cursorCount(lines) <= 1);
      if (width >= 20 && height >= 3)
        assert.equal(
          cursorCount(lines),
          1,
          `missing cursor at ${width}x${height}`,
        );
    }
  }
  view.handleInput(enter);
  assert.equal(results[0].cwd, resolve("/local/project", project));
});

test("a cancelled launch must settle before another launch is allowed", async () => {
  let launches = 0,
    finish;
  const { view, calls } = dashboard(() => {
    launches++;
    return new Promise((done) => {
      finish = done;
    });
  });
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  view.handleInput(esc);
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  assert.equal(launches, 1);
  assert.match(
    view.render(140).join("\n"),
    /previous launch request is still settling/,
  );
  finish({
    message: "Late success",
    tmux: { socket: "/tmp/late.sock", session: "$42" },
  });
  await tick();
  assert.deepEqual(calls.opened, []);
  view.handleInput("\x0e");
  assert.match(view.render(140).join("\n"), /New agent/);
  view.handleInput(esc);
});

test("cancellation before the launch microtask never calls either helper", async () => {
  let launches = 0;
  const { view, calls } = dashboard(async () => {
    launches++;
  });
  view.handleInput("\x0e");
  view.handleInput(enter);
  view.handleInput(esc);
  await tick();
  assert.equal(launches, 0);
  assert.deepEqual(calls.opened, []);
  assert.equal(calls.refresh, 0);
});

for (const retry of [enter, esc])
  test(`opening failure ${retry === enter ? "reconnects the same target" : "returns"} without launching again`, async () => {
    const target = { socket: "/tmp/new.sock", session: "$42", pane: "%7" };
    let launches = 0,
      attempts = 0,
      finish;
    const { view, calls } = dashboard(
      async () => {
        launches++;
        return { message: "HIDDEN-SUCCESS", tmux: target };
      },
      {
        opener: () => {
          if (++attempts === 1)
            throw Error("Opening failed. Existing agent still runs.");
          return new Promise((done) => {
            finish = done;
          });
        },
      },
    );
    view.handleInput("\x0e");
    view.handleInput(enter);
    await tick();
    let output = view.render(140).join("\n");
    assert.match(output, /New agent · cannot open/);
    assert.match(output, /Opening failed/);
    assert.match(output, /Enter reconnect/);
    assert.doesNotMatch(output, /HIDDEN-SUCCESS/);
    assert.equal(calls.refresh, 2);
    assert.equal(calls.opened[0].target, target);
    view.handleInput(retry);
    await tick();
    if (retry === enter) {
      assert.equal(calls.opened.length, 2);
      assert.equal(calls.opened[1].target, target);
      assert.notEqual(calls.opened[1].signal, calls.opened[0].signal);
      assert.match(view.render(140).join("\n"), /Opening agent/);
      view.handleInput(enter);
      view.handleInput(enter);
      await tick();
      assert.equal(calls.opened.length, 2);
      finish("window");
      await tick();
      assert.equal(calls.refresh, 3);
    } else assert.equal(calls.opened.length, 1);
    output = view.render(140).join("\n");
    assert.doesNotMatch(output, /New agent/);
    assert.equal(launches, 1);
    assert.equal(calls.closed, 0);
    assert.equal(view.focused, true);
  });

test("one Escape during automatic opening closes the entire form immediately and aborts only the opener", async () => {
  const target = { socket: "/tmp/new.sock", session: "$42" };
  let launches = 0,
    finish;
  const { view, calls } = dashboard(
    async () => {
      launches++;
      return { message: "Accepted", tmux: target };
    },
    {
      opener: () =>
        new Promise((done) => {
          finish = done;
        }),
    },
  );
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  assert.equal(calls.opened.length, 1);
  view.handleInput(esc);
  assert.equal(calls.opened[0].signal.aborted, true);
  assert.doesNotMatch(view.render(140).join("\n"), /New agent/);
  assert.equal(view.focused, true);
  finish("detached");
  await tick();
  assert.equal(launches, 1);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.closed, 0);
});

test("disposing during automatic opening cancels the opener and ignores its late reply", async () => {
  let finish;
  const { view, calls } = dashboard(
    async () => ({
      message: "Accepted",
      tmux: { socket: "/tmp/new.sock", session: "$42" },
    }),
    {
      opener: () =>
        new Promise((done) => {
          finish = done;
        }),
    },
  );
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.refresh, 1);
  view.dispose();
  view.dispose();
  assert.equal(calls.opened[0].signal.aborted, true);
  finish("detached");
  await tick();
  assert.equal(calls.refresh, 1);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.closed, 0);
});

test("dashboard passes disabled remote discovery into its launch form", async () => {
  const requests = [];
  const { view } = dashboard(
    async (request) => {
      requests.push(request);
      return {
        message: "Accepted",
        tmux: { socket: "/tmp/new.sock", session: "$42" },
      };
    },
    { remoteLaunch: false },
  );
  view.handleInput("\x0e");
  view.handleInput(right);
  assert.match(view.render(140).join("\n"), /Remote launching is disabled/);
  view.handleInput(enter);
  await tick();
  assert.equal(requests[0].host, "local");
});

test("an accepted launch without a structured target reports failure, never a success or clipboard panel", async () => {
  let launches = 0;
  const copied = [];
  const { view, calls } = dashboard(
    async () => {
      launches++;
      return { message: "HIDDEN-SUCCESS", attachCommand: "HIDDEN-COMMAND" };
    },
    { copyCommand: async (command) => copied.push(command) },
  );
  view.handleInput("\x0e");
  view.handleInput(enter);
  await tick();
  const output = view.render(140).join("\n");
  assert.match(output, /Agent started, but opening is unavailable/);
  assert.doesNotMatch(output, /HIDDEN-SUCCESS|HIDDEN-COMMAND|Enter reconnect/);
  view.handleInput("\x19");
  view.handleInput(enter);
  await tick();
  assert.equal(launches, 1);
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(copied, []);
});

test("lean launch validation rejects unsupported destinations, unsafe paths and invalid generated names", () => {
  const request = { host: "local", agent: "pi", cwd: "/project", name: "job" };
  assert.doesNotThrow(() => validateLaunch(request));
  for (const cwd of [
    "~",
    "~/work/project",
    "relative/project",
    "/home/remote/project",
  ])
    assert.doesNotThrow(() =>
      validateLaunch({ ...request, host: "dev01", cwd }),
    );
  for (const change of [
    { host: "other" },
    { agent: "sh" },
    { name: "../bad" },
    { name: "" },
    { name: "x".repeat(65) },
    { cwd: "" },
    { cwd: "   " },
    { cwd: "/project\nother" },
    { cwd: "/project\0other" },
    { cwd: "/project\u202eother" },
  ])
    assert.throws(() => validateLaunch({ ...request, ...change }));
});

for (const cwd of ["~/Code/other", "relative/project", "/home/remote/project"])
  test(`remote dispatcher pins SSH through a config change without resolving ${cwd} locally`, async (t) => {
    const home = temporary(t),
      bin = join(home, "bin"),
      log = join(home, "ssh.jsonl");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ssh"),
      `#!${process.execPath}
const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
  fs.writeFileSync(${JSON.stringify(process.env.PI_EXTENSIONS_CONFIG)}, JSON.stringify({remote:{host:'other-box'}}));
  console.log('/remote/socket\\t$42\\t%7');
});`,
      { mode: 0o700 },
    );
    env(t, "PATH", bin);
    const result = await launchAgent(
      { host: "dev01", agent: "codex", cwd, name: "job-remote" },
      new AbortController().signal,
    );
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].input,
      "",
      "interactive launch must not upload a task",
    );
    assert.ok(calls[0].args.includes("BatchMode=yes"));
    assert.equal(calls[0].args.at(-2), "build-box");
    const script = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${calls[0].args.at(-1)}; printf '%s' "$3"`],
      { encoding: "utf8" },
    );
    assert.ok(script.includes(`cwd='${cwd}'`));
    assert.ok(script.includes("name='job-remote'"));
    assert.match(script, /command -v codex/);
    assert.match(script, /new-session/);
    assert.doesNotMatch(script, /Do the task|shared-dev\/prompts/);
    assert.deepEqual(result.remoteTmux, {
      host: "dev01",
      sshHost: "build-box",
      socket: "/remote/socket",
      session: "$42",
      pane: "%7",
    });
    assert.equal(result.tmux, undefined);
    assert.match(result.attachCommand, /^ssh -t build-box /);
    assert.equal(
      JSON.parse(readFileSync(process.env.PI_EXTENSIONS_CONFIG, "utf8")).remote
        .host,
      "other-box",
    );
  });

test("pre-cancelled dispatch never starts a local or remote helper", async () => {
  const controller = new AbortController();
  controller.abort();
  for (const host of ["local", "dev01"])
    await assert.rejects(
      launchAgent(
        { host, agent: "pi", cwd: "/project", name: "job" },
        controller.signal,
      ),
      /abort/i,
    );
});

function localFixture(t) {
  const home = temporary(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const cwd = join(home, "O'Brien project");
  mkdirSync(cwd);
  env(t, "PATH", `${bin}:/usr/bin:/bin`);
  env(t, "TMPDIR", home);
  env(t, "LAUNCH_FIXTURE", home);
  for (const agent of ["pi", "claude", "codex"])
    writeFileSync(
      join(bin, agent),
      `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.env.LAUNCH_FIXTURE + '/agent.json', JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(['PI_SESSION_ID', 'PI_SESSION_FILE', 'CLAUDECODE', 'CODEX_THREAD_ID'].map(key => [key, process.env[key]]))})); if (process.env.AGENT_FAIL) { fs.writeSync(2, 'fixture startup failed' + String.fromCharCode(10)); process.exit(17); }`,
      { mode: 0o700 },
    );
  writeFileSync(
    join(bin, "osascript"),
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(process.env.LAUNCH_FIXTURE + '/ghostty.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n'); if (process.env.LAUNCH_FAIL) { console.error('fixture denied'); process.exit(1); } if (process.env.LAUNCH_HANG) { setInterval(() => {}, 1000); } else console.log('fixture-window');`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "tmux"),
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(process.env.LAUNCH_FIXTURE + '/tmux.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n'); if (process.env.LAUNCH_FAIL) { console.error('fixture denied'); process.exit(1); } if (process.env.LAUNCH_HANG) { setInterval(() => {}, 1000); } else console.log(process.env.LAUNCH_BAD_ID ? 'unexpected' : (process.env.LAUNCH_BAD_SOCKET ? 'relative' : process.env.LAUNCH_FIXTURE + '/tmux.sock') + String.fromCharCode(9) + '$42');`,
    { mode: 0o700 },
  );
  return {
    home,
    bin,
    cwd,
    tmuxArgs: () =>
      JSON.parse(readFileSync(join(home, "tmux.jsonl"), "utf8").trim()),
    args: () =>
      JSON.parse(readFileSync(join(home, "ghostty.jsonl"), "utf8").trim()),
    handoff: () =>
      join(
        home,
        readdirSync(home).find((name) => name.startsWith("pi-agent-launch-")),
        "request.json",
      ),
  };
}

for (const terminal of ["ghostty", "tmux"])
  for (const agent of ["pi", "claude", "codex"]) {
    test(
      `local ${terminal} ${agent} uses a private handoff, literal task and no permission/model flags`,
      { skip: process.platform !== "darwin" },
      async (t) => {
        const h = localFixture(t);
        const task = `@file --model fake 'quoted' $(touch ${h.home}/injected)\nSecond line.\n`;
        const launch = await launchLocal({
          agent,
          cwd: h.cwd,
          task,
          terminal,
          name: "job",
        });
        assert.match(launch.message, /not yet confirmed/);
        const args = terminal === "ghostty" ? h.args() : h.tmuxArgs();
        if (terminal === "ghostty") {
          assert.equal(args[1], GHOSTTY_SCRIPT);
          assert.equal(args[2], h.cwd);
          assert.equal(launch.attachCommand, undefined);
        } else {
          assert.deepEqual(args.slice(0, 10), [
            "new-session",
            "-d",
            "-s",
            "job",
            "-c",
            h.cwd,
            "-P",
            "-F",
            "#{socket_path}\t#{session_id}",
            process.execPath,
          ]);
          assert.deepEqual(args.slice(args.indexOf(";")), [
            ";",
            "set-option",
            "-w",
            "-t",
            "=job:",
            "remain-on-exit",
            "failed",
            ";",
            "set-option",
            "-w",
            "-t",
            "=job:",
            "@pi-agents-agent",
            agent,
          ]);
          assert.deepEqual(launch.tmux, {
            socket: join(h.home, "tmux.sock"),
            session: "$42",
          });
          assert.equal(
            launch.attachCommand,
            `'${join(h.bin, "tmux")}' -S '${join(h.home, "tmux.sock")}' attach-session -t '$42'`,
          );
          assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
        }
        assert.ok(!args.join(" ").includes(task));
        const file = h.handoff();
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).task, task);
        const options = {
          env: {
            ...process.env,
            PI_SESSION_ID: "old",
            PI_SESSION_FILE: "old",
            CLAUDECODE: "1",
            CODEX_THREAD_ID: "old",
          },
        };
        if (terminal === "ghostty")
          execFileSync(
            "/bin/bash",
            ["--noprofile", "--norc", "-c", `exec -l ${args[3]}`],
            options,
          );
        else {
          const runner = args.slice(9, args.indexOf(";"));
          execFileSync(runner[0], runner.slice(1), options);
        }
        const result = JSON.parse(
          readFileSync(join(h.home, "agent.json"), "utf8"),
        );
        assert.deepEqual(result.args, [
          "--",
          `Do the following task:\n\n${task}`,
        ]);
        assert.equal(result.cwd, realpathSync(h.cwd));
        for (const key of [
          "PI_SESSION_ID",
          "PI_SESSION_FILE",
          "CLAUDECODE",
          "CODEX_THREAD_ID",
        ])
          assert.equal(result.env[key], undefined);
        assert.equal(existsSync(dirname(file)), false);
        assert.equal(existsSync(join(h.home, "injected")), false);
      },
    );
  }

test(
  "local empty task starts an interactive agent without a prompt",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    await launchLocal({ agent: "pi", cwd: h.cwd, task: "" });
    execFileSync("/bin/bash", [
      "--noprofile",
      "--norc",
      "-c",
      `exec -l ${h.args()[3]}`,
    ]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(h.home, "agent.json"), "utf8")).args,
      [],
    );
  },
);

test(
  "invalid local requests and missing executables never reach Ghostty",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    const request = { agent: "pi", cwd: h.cwd, task: "" };
    for (const change of [
      { agent: "bash" },
      { terminal: "unknown" },
      { terminal: "tmux", name: "bad name" },
      { cwd: "relative" },
      { cwd: join(h.home, "absent") },
      { task: "\0" },
      { cwd: join(h.bin, "pi") },
    ])
      await assert.rejects(launchLocal({ ...request, ...change }));
    rmSync(join(h.bin, "pi"));
    await assert.rejects(launchLocal(request));
    assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
  },
);

test(
  "lean local dispatch always defaults to tmux and starts an interactive agent without invoking Ghostty",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    const result = await launchAgent(
      {
        host: "local",
        agent: "pi",
        name: "job",
        cwd: h.cwd,
      },
      new AbortController().signal,
    );
    assert.match(result.attachCommand, /attach-session/);
    assert.deepEqual(result.tmux, {
      socket: join(h.home, "tmux.sock"),
      session: "$42",
    });
    assert.equal(JSON.parse(readFileSync(h.handoff(), "utf8")).task, "");
    const args = h.tmuxArgs();
    const runner = args.slice(9, args.indexOf(";"));
    execFileSync(runner[0], runner.slice(1));
    assert.deepEqual(
      JSON.parse(readFileSync(join(h.home, "agent.json"), "utf8")).args,
      [],
    );
    assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
  },
);

test(
  "missing tmux fails before creating a handoff and never falls back to Ghostty",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    rmSync(join(h.bin, "tmux"));
    await assert.rejects(
      launchLocal({
        agent: "pi",
        cwd: h.cwd,
        task: "",
        terminal: "tmux",
        name: "job",
      }),
    );
    assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
    assert.ok(
      !readdirSync(h.home).some((name) => name.startsWith("pi-agent-launch-")),
    );
  },
);

for (const condition of [
  "LAUNCH_FAIL",
  "LAUNCH_BAD_ID",
  "LAUNCH_BAD_SOCKET",
  "LAUNCH_HANG",
])
  test(
    `tmux ${condition} never retries, falls back or removes a possibly consumed handoff`,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const h = localFixture(t);
      env(t, condition, "1");
      await assert.rejects(
        launchLocal(
          {
            agent: "pi",
            cwd: h.cwd,
            task: "task",
            terminal: "tmux",
            name: "job",
          },
          condition === "LAUNCH_HANG" ? AbortSignal.timeout(500) : undefined,
        ),
        /Check tmux list-sessions before retrying/,
      );
      assert.equal(
        readFileSync(join(h.home, "tmux.jsonl"), "utf8").trim().split("\n")
          .length,
        1,
      );
      assert.equal(existsSync(h.handoff()), true);
      assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
    },
  );

test(
  "real local tmux preserves failed startup output, clears parent context and refuses an existing session name",
  { skip: process.platform !== "darwin" || !realTmux, timeout: 15_000 },
  async (t) => {
    const h = localFixture(t);
    const socket = join(h.home, "s");
    writeFileSync(
      join(h.bin, "tmux"),
      `#!${process.execPath}\nconst cp = require('node:child_process'); const r = cp.spawnSync(${JSON.stringify(realTmux)}, ['-S', ${JSON.stringify(socket)}, '-f', '/dev/null', ...process.argv.slice(2)], { env: { ...process.env, TMUX: '', TMUX_PANE: '' }, stdio: 'inherit' }); process.exit(r.status ?? 1);`,
      { mode: 0o700 },
    );
    env(t, "AGENT_FAIL", "1");
    env(t, "PI_SESSION_ID", "parent");
    env(t, "PI_SESSION_FILE", "parent.jsonl");
    env(t, "CLAUDECODE", "1");
    env(t, "CODEX_THREAD_ID", "parent");
    const task = `@file --model fake 'quoted' $(touch ${h.home}/injected)\nSecond line.\n`;
    const request = {
      agent: "pi",
      cwd: h.cwd,
      task,
      terminal: "tmux",
      name: "job",
    };
    try {
      const launch = await launchLocal(request);
      assert.match(launch.attachCommand, /attach-session -t '\$\d+'/);
      assert.ok(
        launch.attachCommand.includes(`-S '${socket}'`),
        "attach must target the same private tmux server",
      );
      let pane;
      for (let i = 0; i < 100; i++) {
        pane = execFileSync(
          realTmux,
          [
            "-S",
            socket,
            "list-panes",
            "-t",
            "=job:",
            "-F",
            "#{pane_id}:#{pane_dead}:#{pane_dead_status}",
          ],
          { encoding: "utf8" },
        ).trim();
        if (pane.endsWith(":1:17")) break;
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.match(pane, /^%\d+:1:17$/);
      const [discovered] = localTmuxRows(
        execFileSync(
          realTmux,
          ["-S", socket, "list-panes", "-a", "-F", PANE_FORMAT],
          { encoding: "utf8" },
        ),
        [],
      );
      assert.equal(discovered.status, "error");
      assert.equal(discovered.title, "Pi in O'Brien project");
      assert.equal(discovered.tmuxName, "job");
      assert.equal(discovered.tmuxAgent, "pi");
      assert.equal(discovered.tmuxPids, undefined);
      assert.equal(discovered.tmux.socket, launch.tmux.socket);
      assert.equal(discovered.tmux.session, launch.tmux.session);
      const result = JSON.parse(
        readFileSync(join(h.home, "agent.json"), "utf8"),
      );
      assert.deepEqual(result.args, [
        "--",
        `Do the following task:\n\n${task}`,
      ]);
      assert.equal(result.cwd, realpathSync(h.cwd));
      assert.deepEqual(result.env, {});
      assert.equal(existsSync(join(h.home, "injected")), false);
      assert.ok(
        !readdirSync(h.home).some((name) =>
          name.startsWith("pi-agent-launch-"),
        ),
      );
      const output = execFileSync(
        realTmux,
        ["-S", socket, "capture-pane", "-p", "-S", "-", "-t", "=job:"],
        { encoding: "utf8" },
      );
      assert.match(output, /fixture startup failed/);
      await assert.rejects(
        launchLocal({ ...request, task: "must not replace" }),
        /duplicate session/,
      );
      assert.equal(
        execFileSync(
          realTmux,
          [
            "-S",
            socket,
            "list-panes",
            "-t",
            "=job:",
            "-F",
            "#{pane_id}:#{pane_dead}:#{pane_dead_status}",
          ],
          { encoding: "utf8" },
        ).trim(),
        pane,
      );
      assert.equal(existsSync(join(h.home, "ghostty.jsonl")), false);
    } finally {
      spawnSync(realTmux, ["-S", socket, "kill-server"]);
    }
  },
);

test(
  "ambiguous Ghostty failure never retries or deletes a potentially consumed handoff",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    env(t, "LAUNCH_FAIL", "1");
    await assert.rejects(
      launchLocal({ agent: "pi", cwd: h.cwd, task: "task" }),
      /Check Ghostty before retrying/,
    );
    assert.equal(
      readFileSync(join(h.home, "ghostty.jsonl"), "utf8").trim().split("\n")
        .length,
      1,
    );
    assert.equal(existsSync(h.handoff()), true);
  },
);

test(
  "cancelling Ghostty launch aborts the helper without claiming to undo a launch",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const h = localFixture(t);
    env(t, "LAUNCH_HANG", "1");
    await assert.rejects(
      launchLocal(
        { agent: "pi", cwd: h.cwd, task: "task" },
        AbortSignal.timeout(500),
      ),
      /Check Ghostty before retrying/,
    );
    assert.equal(existsSync(h.handoff()), true);
  },
);
