import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { remoteTmuxAttachArgs } from "../bin/dev01.mjs";

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
const alias = {
  "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
  "@earendil-works/pi-tui": tuiPath,
};
const jiti = createJiti(import.meta.url, { alias });
const { attachAgent, remoteAttachCommand } = await jiti.import(
  join(source, "attach.ts"),
);
const { isRemoteTmuxTarget } = await jiti.import(
  join(source, "remote-target.ts"),
);
const { Dashboard } = await jiti.import(join(source, "dashboard.ts"));
const { getThemeByName } = await import(
  pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js"))
);
const { getKeybindings } = await import(pathToFileURL(tuiPath));
const target = {
  host: "dev01",
  sshHost: "build-box",
  socket: "/remote/socket",
  session: "$42",
  pane: "%7",
};
const row = {
  source: "pi",
  host: "dev01",
  key: "remote",
  cwd: "/remote/project",
  title: "REMOTE-JOB",
  preview: "",
  status: "unknown",
  updated: 0,
  owners: [],
  live: true,
  current: false,
  remoteTmux: target,
  detail:
    "No Pi status record. Install the Agents extension and run /reload in this Pi session.",
};
const tick = () => new Promise((done) => setImmediate(done));
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
  const root = mkdtempSync(join(tmpdir(), "agents-remote-"));
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
function fixture(t, mode = "ok", nested = false) {
  const root = temporary(t),
    bin = join(root, "bin"),
    log = join(root, "calls.jsonl");
  mkdirSync(bin);
  const prefix = `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({file:require('node:path').basename(process.argv[1]),args})+'\\n');`;
  writeFileSync(
    join(bin, "ssh"),
    `#!${process.execPath}\n${prefix}
if (args.at(-1).includes('exec tmux')) { ${mode === "hang" ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);" : `setTimeout(()=>process.exit(${mode === "fail" ? 255 : 0}),120);`} }
else {
  if (${JSON.stringify(mode)} === 'reconfigure') fs.writeFileSync(${JSON.stringify(process.env.PI_EXTENSIONS_CONFIG)}, JSON.stringify({remote:{host:'other-box'}}));
  console.log(${JSON.stringify(mode === "moved" ? "$43 %7" : "$42 %7")});
}`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "tmux"),
    `#!${process.execPath}\n${prefix}\nif(args.includes('display-message')) console.log('$3'); else if(!args.includes('new-window')) process.exit(9);`,
    { mode: 0o700 },
  );
  env(t, "PATH", bin);
  env(t, "TMUX", nested ? "/tmp/outer,123,0" : undefined);
  env(t, "TMUX_PANE", nested ? "%2" : undefined);
  for (const stream of [process.stdin, process.stdout]) {
    const old = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    t.after(() => {
      if (old) Object.defineProperty(stream, "isTTY", old);
      else delete stream.isTTY;
    });
  }
  const events = [],
    tui = {
      stop: () => events.push("stop"),
      start: () => events.push("start"),
      requestRender: (force) => events.push(force),
    };
  return {
    root,
    events,
    tui,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
  };
}
function view(opener, rows = [row], launcher) {
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const dashboard = new Dashboard(
    tui,
    getThemeByName("dark"),
    getKeybindings(),
    "/project",
    () => {},
    () => {},
    () => {},
    undefined,
    launcher,
    true,
    opener,
  );
  dashboard.setData(rows);
  dashboard.focused = true;
  return dashboard;
}

test("remote identities require a bound SSH destination and exact socket/session/pane syntax", async (t) => {
  const f = fixture(t);
  assert.ok(isRemoteTmuxTarget(target));
  for (const change of [
    { host: "other-host" },
    { host: "-oProxyCommand=evil" },
    ...[
      undefined,
      null,
      123,
      "",
      "-oProxyCommand=evil",
      "box other",
      "box;evil",
      "build-box\n",
    ].map((sshHost) => ({ sshHost })),
    { socket: "relative" },
    { socket: "/bad\npath" },
    { session: "$42\n" },
    { pane: "%7\n" },
    { pane: undefined },
  ]) {
    const invalid = { ...target, ...change };
    assert.equal(isRemoteTmuxTarget(invalid), false);
    await assert.rejects(
      attachAgent(f.tui, invalid, new AbortController().signal),
      /Invalid remote/,
    );
  }
  const { host, ...missingMarker } = target;
  assert.equal(isRemoteTmuxTarget(missingMarker), false);
  await assert.rejects(
    attachAgent(f.tui, missingMarker, new AbortController().signal),
    /Invalid remote/,
  );
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.events, []);
});

for (const mode of ["ok", "fail", "moved"])
  test(`remote terminal handoff ${mode} verifies on dev01 and restores the renderer`, async (t) => {
    const f = fixture(t, mode);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    t.after(() => clearInterval(timer));
    const pending = attachAgent(f.tui, target, new AbortController().signal);
    if (mode === "ok") await pending;
    else
      await assert.rejects(
        pending,
        mode === "moved" ? /moved or exited/ : /exited with code 255/,
      );
    assert.deepEqual(f.events, mode === "moved" ? [] : ["stop", "start", true]);
    if (mode !== "moved") assert.ok(ticks > 5);
    const calls = f.calls();
    assert.ok(calls.every((c) => c.file === "ssh"));
    assert.equal(calls.length, mode === "moved" ? 1 : 2);
    for (const c of calls) {
      assert.ok(c.args.includes("BatchMode=yes"));
      assert.equal(c.args.at(-2), "build-box");
      assert.doesNotMatch(c.args.at(-1), /kill-|new-session|claude resume/);
    }
    if (mode !== "moved") {
      assert.ok(calls[1].args.includes("-t"));
      assert.match(calls[1].args.at(-1), /moved or exited/);
    }
  });

test("remote opening inside tmux creates a sibling SSH window without stopping Pi's renderer", async (t) => {
  const f = fixture(t, "ok", true);
  assert.equal(
    await attachAgent(f.tui, target, new AbortController().signal),
    "window",
  );
  assert.deepEqual(f.events, []);
  const calls = f.calls();
  assert.deepEqual(
    calls.map((c) => c.file),
    ["ssh", "tmux", "tmux"],
  );
  const args = calls[2].args;
  assert.deepEqual(args.slice(0, 9), [
    "-S",
    "/tmp/outer",
    "new-window",
    "-t",
    "$3",
    "-n",
    "dev01",
    "ssh",
    "-o",
  ]);
  assert.equal(args.at(-2), "build-box");
  assert.equal(args.at(-1), remoteAttachCommand(target));
  assert.ok(
    !calls.some((c) =>
      c.args.some((a) =>
        /switch-client|detach-client|kill-pane|kill-session/.test(a),
      ),
    ),
  );
});

test("moved remote targets and malformed outer tmux identity never create a window", async (t) => {
  const f = fixture(t, "moved", true);
  await assert.rejects(
    attachAgent(f.tui, target, new AbortController().signal),
    /moved or exited/,
  );
  assert.equal(f.calls().length, 1);
  env(t, "TMUX", "malformed");
  // A healthy probe is needed to reach the outer identity guard.
  writeFileSync(
    join(f.root, "bin/ssh"),
    `#!${process.execPath}\nconsole.log('$42 %7');`,
    { mode: 0o700 },
  );
  await assert.rejects(
    attachAgent(f.tui, target, new AbortController().signal),
    /local tmux pane/,
  );
  assert.deepEqual(f.events, []);
});

test("remote opening without a configured host never probes processes or SSH", async (t) => {
  const f = fixture(t);
  writeFileSync(process.env.PI_EXTENSIONS_CONFIG, "{}");
  await assert.rejects(
    attachAgent(f.tui, target, new AbortController().signal),
    /remote.host/,
  );
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.events, []);
});

for (const nested of [false, true]) {
  test(`stale targets cannot attach identical tmux IDs on a different configured host ${nested ? "inside" : "outside"} tmux`, async (t) => {
    const f = fixture(t, "ok", nested);
    const other = { ...target, sshHost: "other-box" };
    writeFileSync(
      process.env.PI_EXTENSIONS_CONFIG,
      JSON.stringify({ remote: { host: other.sshHost } }),
    );
    assert.ok(isRemoteTmuxTarget(target));
    assert.ok(isRemoteTmuxTarget(other));
    await assert.rejects(
      attachAgent(f.tui, target, new AbortController().signal),
      /destination changed.*Refresh \/agents/,
    );
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(f.events, []);
    // Both hosts' mock probes return the exact same socket/session/pane IDs.
    await attachAgent(f.tui, other, new AbortController().signal);
    assert.equal(f.calls()[0].args.at(-2), other.sshHost);
    assert.ok(f.calls().every((call) => !call.args.includes(target.sshHost)));
  });

  test(`config changes during the remote probe cannot retarget ${nested ? "a sibling window" : "terminal handoff"}`, async (t) => {
    const f = fixture(t, "reconfigure", nested);
    await attachAgent(f.tui, target, new AbortController().signal);
    assert.equal(
      JSON.parse(readFileSync(process.env.PI_EXTENSIONS_CONFIG, "utf8")).remote
        .host,
      "other-box",
    );
    const calls = f.calls();
    assert.equal(calls.length, nested ? 3 : 2);
    assert.equal(calls[0].args.at(-2), target.sshHost);
    assert.equal(calls.at(-1).args.at(-2), target.sshHost);
    assert.ok(calls.every((call) => !call.args.includes("other-box")));
    assert.deepEqual(f.events, nested ? [] : ["stop", "start", true]);
    await assert.rejects(
      attachAgent(f.tui, target, new AbortController().signal),
      /destination changed/,
    );
    assert.deepEqual(f.calls(), calls, "a manual reconnect also fails closed");
  });
}

test("the probe uses the pinned destination even if config changes before remote() starts", async (t) => {
  const f = fixture(t);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    get() {
      writeFileSync(
        process.env.PI_EXTENSIONS_CONFIG,
        JSON.stringify({ remote: { host: "other-box" } }),
      );
      return true;
    },
  });
  await attachAgent(f.tui, target, new AbortController().signal);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every((call) => call.args.at(-2) === target.sshHost));
  assert.deepEqual(f.events, ["stop", "start", true]);
});

test("pre-cancelled opening never starts a helper", async (t) => {
  const f = fixture(t);
  const c = new AbortController();
  c.abort();
  await assert.rejects(attachAgent(f.tui, target, c.signal), /abort/i);
  assert.deepEqual(f.calls(), []);
});

test(
  "cancelling a stuck SSH attach kills only the local helper",
  { timeout: 4000 },
  async (t) => {
    const f = fixture(t, "hang");
    const controller = new AbortController();
    const pending = attachAgent(f.tui, target, controller.signal);
    for (let i = 0; i < 100 && f.calls().length < 2; i++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(f.calls().length, 2);
    // Let the fixture install its SIGTERM handler.
    await new Promise((done) => setTimeout(done, 50));
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(f.events, ["stop"]);
    assert.equal(f.calls().length, 2);
  },
);

test("dashboard opens only fresh structured remote targets and exposes the missing-status reason", async () => {
  const opened = [];
  const dashboard = view(async (value) => {
    opened.push(value);
    return "window";
  });
  assert.match(dashboard.render(140).join("\n"), /No Pi status record/);
  assert.match(dashboard.render(140).join("\n"), /Enter: Attach dev01 tmux/);
  dashboard.handleInput("\r");
  await tick();
  assert.deepEqual(opened, [target]);
  assert.match(
    dashboard.render(140).join("\n"),
    /Opened dev01 in another tmux window/,
  );
  for (const change of [
    { live: false },
    { host: "other" },
    { remoteTmux: undefined },
    { remoteTmux: { ...target, host: "other" } },
    { remoteTmux: { ...target, sshHost: undefined } },
  ]) {
    const blocked = view(
      async (value) => opened.push(value),
      [{ ...row, ...change, nativeCommand: "evil-command" }],
    );
    blocked.handleInput("\r");
    await tick();
  }
  assert.equal(opened.length, 1);
});

test("Claude explains a missing activity timestamp without replacing it with poll time", () => {
  const dashboard = view(undefined, [
    { ...row, source: "claude", status: "ready" },
  ]);
  const output = dashboard.render(140).join("\n");
  assert.match(output, /Activity time not provided by Claude/);
  assert.match(output, /n\/a/);
});

test("remote launch opens automatically and reconnects the exact new target without launching twice", async () => {
  for (const action of ["opened", "reconnect", "cancel"]) {
    const launched = { ...target, session: "$99", pane: "%9" };
    const opened = [],
      requests = [];
    const dashboard = view(
      async (value) => {
        opened.push(value);
        if (action !== "opened" && opened.length === 1)
          throw Error("SSH opening failed. Remote agent still runs.");
        return "window";
      },
      [row],
      async (request) => {
        requests.push(request);
        return {
          message: "HIDDEN-LAUNCH-SUCCESS",
          attachCommand: "HIDDEN-SSH-COMMAND",
          remoteTmux: launched,
        };
      },
    );
    dashboard.handleInput("\x0e");
    dashboard.handleInput("\x1b[C");
    dashboard.handleInput("\r");
    await tick();
    assert.deepEqual(opened, [launched]);
    assert.equal(requests[0].host, "dev01");
    assert.equal(requests[0].cwd, "~/work/project");
    assert.deepEqual(Object.keys(requests[0]).sort(), [
      "agent",
      "cwd",
      "host",
      "name",
    ]);
    let output = dashboard.render(140).join("\n");
    assert.doesNotMatch(
      output,
      /Enter opens|HIDDEN-LAUNCH-SUCCESS|HIDDEN-SSH-COMMAND/,
    );
    if (action !== "opened") {
      assert.match(output, /SSH opening failed/);
      assert.match(output, /Enter reconnect/);
      dashboard.handleInput(action === "reconnect" ? "\r" : "\x1b");
      await tick();
      assert.deepEqual(
        opened,
        action === "reconnect" ? [launched, launched] : [launched],
      );
    }
    output = dashboard.render(140).join("\n");
    assert.doesNotMatch(output, /New agent/);
    assert.equal(requests.length, 1);
    assert.equal(dashboard.focused, true);
    assert.equal(dashboard.selectedRow().key, row.key);
  }
});

const realTmux = spawnSync("which", ["tmux"], {
  encoding: "utf8",
}).stdout?.trim();
for (const change of ["moved", "exited"])
  test(
    `remote command queue refuses a pane ${change} after its discovery probe`,
    { skip: !realTmux },
    (t) => {
      const root = temporary(t),
        socket = join(root, "s");
      const run = (...args) =>
        execFileSync(realTmux, ["-S", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          env: { ...process.env, TMUX: "", TMUX_PANE: "" },
        });
      run(
        "new-session",
        "-d",
        "-s",
        "first",
        process.execPath,
        "-e",
        "setInterval(()=>{},1000)",
      );
      t.after(() => spawnSync(realTmux, ["-S", socket, "kill-server"]));
      run(
        "new-window",
        "-d",
        "-t",
        "$0",
        process.execPath,
        "-e",
        "setInterval(()=>{},1000)",
      );
      const stale = { ...target, socket, session: "$0", pane: "%0" };
      assert.equal(
        run("display-message", "-p", "-t", "%0", "#{session_id}").trim(),
        "$0",
      );
      if (change === "moved") {
        run(
          "new-session",
          "-d",
          "-s",
          "second",
          process.execPath,
          "-e",
          "setInterval(()=>{},1000)",
        );
        run("move-pane", "-s", "%0", "-t", "%2");
      } else run("kill-pane", "-t", "%0");
      const result = spawnSync(realTmux, remoteTmuxAttachArgs(stale), {
        encoding: "utf8",
      });
      assert.match(
        result.stdout + result.stderr,
        /moved or exited|can't find pane/,
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /open terminal|not a terminal/,
      );
      assert.equal(run("list-clients").trim(), "");
    },
  );

const python = "/usr/bin/python3";
for (const nested of [false, true])
  test(
    `real PTY remote ${nested ? "inside" : "outside"} local tmux accepts input and returns without stopping the remote job`,
    {
      skip: !realTmux || spawnSync(python, ["--version"]).status !== 0,
      timeout: 25_000,
    },
    (t) => {
      const root = temporary(t),
        bin = join(root, "bin"),
        socket = join(root, "remote"),
        outer = join(root, "outer");
      mkdirSync(bin);
      const agent = join(root, "agent.mjs");
      writeFileSync(
        agent,
        "process.stdout.write('REMOTE-READY\\n');process.stdin.on('data',d=>process.stdout.write('REMOTE-ECHO:'+d));setInterval(()=>{},1000);",
      );
      const cleanEnv = { ...process.env, TMUX: "", TMUX_PANE: "" };
      const tmux = (...args) =>
        execFileSync(realTmux, ["-S", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          env: cleanEnv,
        });
      tmux("new-session", "-d", "-s", "remote", process.execPath, agent);
      tmux(
        "new-window",
        "-d",
        "-n",
        "other-agent",
        process.execPath,
        "-e",
        "process.stdout.write('WRONG-AGENT');setInterval(()=>{},1000)",
      );
      tmux("select-window", "-t", "$0:1");
      t.after(() => {
        spawnSync(realTmux, ["-S", socket, "kill-server"]);
        if (nested) spawnSync(realTmux, ["-S", outer, "kill-server"]);
      });
      const selected = { ...target, socket, session: "$0", pane: "%0" };
      // Only SSH is faked. It executes the exact remote verification and attach
      // shell command against a second private tmux server. No network/model call.
      writeFileSync(
        join(bin, "ssh"),
        `#!${process.execPath}\nconst c=require('node:child_process').spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));`,
        { mode: 0o700 },
      );
      writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec '${realTmux}' "$@"\n`, {
        mode: 0o700,
      });
      const host = join(root, "host.mjs");
      writeFileSync(
        host,
        `import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(packageDir, "package.json"))});const {createJiti}=require('jiti');const jiti=createJiti(import.meta.url,{alias:${JSON.stringify(alias)}});
const {ProcessTerminal,getKeybindings}=await import(${JSON.stringify(pathToFileURL(tuiPath).href)});
const {TuiMainScreen}=await import(${JSON.stringify(pathToFileURL(join(dirname(tuiPath), "tui-main-screen.js")).href)});
const {getThemeByName}=await import(${JSON.stringify(pathToFileURL(join(packageDir, "dist/modes/interactive/theme/theme.js")).href)});
const {Dashboard}=await jiti.import(${JSON.stringify(join(source, "dashboard.ts"))});const {attachAgent}=await jiti.import(${JSON.stringify(join(source, "attach.ts"))});
const tui=new TuiMainScreen(new ProcessTerminal());const view=new Dashboard(tui,getThemeByName('dark'),getKeybindings(),'/project',()=>{tui.stop();process.exit(0);},()=>{},()=>{},undefined,undefined,true,(target,signal)=>attachAgent(tui,target,signal));
view.setData([${JSON.stringify({ ...row, title: "PARENT-DASHBOARD", remoteTmux: selected })}]);tui.addChild(view);tui.setFocus(view);tui.start();`,
      );
      const testEnv = {
        ...cleanEnv,
        PATH: `${bin}:${process.env.PATH}`,
        TERM: "xterm-256color",
      };
      if (nested)
        execFileSync(
          realTmux,
          [
            "-S",
            outer,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "dashboard",
            process.execPath,
            host,
          ],
          { env: testEnv },
        );
      const script = `import os,pty,select,subprocess,sys,time,fcntl,termios,struct,json
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,140,0,0))
def setup():
 os.setsid()
 fcntl.ioctl(slave,termios.TIOCSCTTY,0)
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup)
os.close(slave)
data=b''
def wait(marker):
 global data
 end=time.time()+8
 while marker not in data:
  if time.time()>end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-4000:]))
  if select.select([master],[],[],.1)[0]: data+=os.read(master,65536)
wait(b'PARENT-DASHBOARD')
os.write(master,b'\\r')
wait(b'REMOTE-READY')
os.write(master,b'hello-remote\\r')
wait(b'REMOTE-ECHO:hello-remote')
os.write(master,${nested ? "b'\\x02p'" : "b'\\x02d'"})
wait(${nested ? "b'Opened dev01 in another tmux window'" : "b'Returned to Agents'"})
os.write(master,${nested ? "b'\\x02d'" : "b'\\x1b'"})
end=time.time()+5
while p.poll() is None and time.time()<end:
 if select.select([master],[],[],.05)[0]:
  try: data+=os.read(master,65536)
  except OSError: break
if p.poll() is None:
 p.kill();p.wait();raise RuntimeError('host did not return')
print(json.dumps({'exit':p.returncode}))
os.close(master)
`;
      const command = nested
        ? [realTmux, "-S", outer, "attach-session", "-t", "$0"]
        : [process.execPath, host];
      const output = execFileSync(python, ["-c", script, ...command], {
        encoding: "utf8",
        timeout: 23_000,
        env: testEnv,
      });
      assert.deepEqual(JSON.parse(output), { exit: 0 });
      assert.equal(
        tmux("display-message", "-p", "-t", "%0", "#{pane_dead}").trim(),
        "0",
      );
      if (nested)
        assert.equal(
          execFileSync(
            realTmux,
            ["-S", outer, "list-windows", "-t", "$0", "-F", "#{window_name}"],
            { encoding: "utf8" },
          )
            .trim()
            .split("\n").length,
          2,
        );
    },
  );
