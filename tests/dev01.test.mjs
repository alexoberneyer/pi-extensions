import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  attachCommand,
  remoteTmuxAttachArgs,
  cleanOutput,
  listPanes,
  quote,
  remote,
  runJob,
  runProcess,
  snapshot,
  startJob,
  startJobWithTarget,
  startInteractiveWithTarget,
  transfer,
  uploadClipboard,
} from "../bin/dev01.mjs";
import { readConfig, expandPath, packagePath } from "../lib/config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { dev01Rows, createDev01Adapter } = await jiti.import(
  join(root, "extensions/agents/dev01.ts"),
);
const { ExternalSessions } = await jiti.import(
  join(root, "extensions/agents/external.ts"),
);
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const python = execFileSync(
  "python3",
  ["-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" },
).trim();
const realTmux = spawnSync("which", ["tmux"], {
  encoding: "utf8",
}).stdout?.trim();
const freshAgentVariables = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
];

function env(t, key, value) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "dev01-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test.beforeEach((t) => {
  const config = join(temporary(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      remote: {
        host: "build-box",
        project: "~/work/project",
        sharedDirectory: "shared-dev",
      },
    }),
  );
  env(t, "PI_EXTENSIONS_CONFIG", config);
});

function fake(t) {
  const home = temporary(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(home, "work/project"), { recursive: true });
  env(t, "HOME", home);
  env(t, "PATH", `${bin}:/usr/bin:/bin`);
  env(t, "DEV01_FIXTURE_HOME", home);
  const script = (name, code) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${code}`, {
      mode: 0o700,
    });
  const prelude = `const fs = require('node:fs'); const home = process.env.DEV01_FIXTURE_HOME; const args = process.argv.slice(2);`;
  script(
    "ssh",
    `${prelude}
    (async () => {
      const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
      const input = Buffer.concat(chunks);
      fs.writeFileSync(home + '/ssh-input', input);
      fs.writeFileSync(home + '/ssh-args', JSON.stringify(args));
      fs.appendFileSync(home + '/ssh-log', JSON.stringify(args) + '\\n');
      if (process.env.DEV01_FIXTURE_RECONFIGURE) fs.writeFileSync(process.env.PI_EXTENSIONS_CONFIG, process.env.DEV01_FIXTURE_RECONFIGURE);
      if (process.env.DEV01_FIXTURE_HANG) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
      if (process.env.DEV01_FIXTURE_FAIL) { process.stderr.write('offline'); process.exit(255); }
      const command = args.at(-1);
      if (command.includes('python3 -')) { process.stdout.write(fs.readFileSync(home + '/snapshot.json')); return; }
      const child = require('node:child_process').spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin.on('error', () => {}); child.stdin.end(process.env.DEV01_FIXTURE_TRUNCATE ? input.subarray(0, 2) : input);
      child.on('exit', code => process.exit(code ?? 1));
    })();`,
  );
  // Avoid a real login shell changing HOME/PATH while still exercising both quoting layers.
  writeFileSync(
    join(bin, "bash"),
    '#!/bin/sh\n[ "$1" = "-lc" ] || exit 2\nshift\nif [ -f "$DEV01_FIXTURE_HOME/login-env" ]; then . "$DEV01_FIXTURE_HOME/login-env"; fi\nexec /bin/bash -c "$1"\n',
    { mode: 0o700 },
  );
  script(
    "claude",
    `${prelude} process.stdout.write(fs.readFileSync(home + '/claude.json'));`,
  );
  for (const agent of ["pi", "codex"]) script(agent, "process.exit(0);");
  script(
    "tmux",
    `${prelude}
    fs.appendFileSync(home + '/tmux-log', JSON.stringify(args) + '\\n');
    if (args[0] === 'has-session') {
      if (process.env.DEV01_FIXTURE_COLLIDE) { fs.writeFileSync(home + '/running', 'racing session'); process.exit(1); }
      process.exit(fs.existsSync(home + '/running') ? 0 : 1);
    }
    if (args[0] === 'new-session') {
      if (process.env.DEV01_FIXTURE_TMUX_FAIL) { process.stderr.write('fixture tmux refused'); process.exit(1); }
      try { fs.writeFileSync(home + '/running', 'yes', { flag: 'wx' }); }
      catch { process.stderr.write('duplicate session'); process.exit(1); }
      process.stdout.write(process.env.DEV01_FIXTURE_IDENTITY ?? fs.readFileSync(home + '/identity', 'utf8'));
      process.exit(0);
    }
    if (args[0] === 'list-panes') { process.stdout.write(fs.readFileSync(home + '/panes')); process.exit(0); }
    if (args[0] === 'attach-session' || args[2] === 'if-shell') process.exit(0);
    process.exit(2);`,
  );
  script("ps", `${prelude} console.log('${process.pid} 201\\n201 1');`);
  script(
    "rsync",
    `${prelude} fs.writeFileSync(home + '/rsync-args', JSON.stringify(args)); console.log('fixture transfer');`,
  );
  script(
    "osascript",
    `${prelude}
    if (process.env.DEV01_FIXTURE_NO_IMAGE) process.exit(1);
    fs.writeFileSync(args.at(-1), Buffer.from([137,80,78,71,13,10,26,10]));
    if (process.env.DEV01_FIXTURE_CLIPBOARD_RECONFIGURE) fs.writeFileSync(process.env.PI_EXTENSIONS_CONFIG, process.env.DEV01_FIXTURE_CLIPBOARD_RECONFIGURE);`,
  );
  script(
    "pbcopy",
    `${prelude}
    (async () => { const chunks = []; for await (const c of process.stdin) chunks.push(c); fs.writeFileSync(home + '/clipboard', Buffer.concat(chunks)); })();`,
  );
  writeFileSync(
    join(home, "identity"),
    `${remoteTarget.socket}\t${remoteTarget.session}\t${remoteTarget.pane}\n`,
  );
  writeFileSync(join(home, "snapshot.json"), JSON.stringify(data()));
  writeFileSync(join(home, "claude.json"), "[]");
  writeFileSync(
    join(home, "panes"),
    `${remoteTarget.socket}\t$0\t%0\t201\t/remote/work/project\tclaude\tjob\n`,
  );
  return home;
}
function data(overrides = {}) {
  return {
    version: 1,
    sshHost: "build-box",
    now: 100_000,
    panes: [
      {
        socket: "/remote/tmux O'Brien,default",
        id: "%0",
        sessionId: "$0",
        pid: 201,
        cwd: "/remote/project",
        name: "job",
        command: "claude",
      },
    ],
    claude: [
      {
        record: {
          sessionId: "same-id",
          pid: 202,
          cwd: "/remote/project",
          name: "Remote task",
          kind: "interactive",
          status: "busy",
        },
        pane: "%0",
      },
    ],
    pi: [],
    ...overrides,
  };
}
function presence(overrides = {}) {
  return {
    version: 1,
    instance: "instance",
    pid: process.pid,
    sessionId: "pi-id",
    sessionFile: "/remote/session.jsonl",
    cwd: "/remote/project",
    title: "Remote Pi",
    preview: "Reply",
    model: "test/model",
    status: "ready",
    updated: 90_000,
    heartbeat: 99_000,
    tmux: { socket: remoteTarget.socket, pane: remoteTarget.pane },
    ...overrides,
  };
}
const remoteTarget = {
  host: "dev01",
  sshHost: "build-box",
  socket: "/remote/tmux O'Brien,default",
  session: "$0",
  pane: "%0",
};
const tick = () => new Promise((done) => setImmediate(done));

// SSH, rsync and clipboard are fixtures. Real tmux tests use private sockets.
test("transfers preserve direction and update-only semantics, and reject destructive flags", async (t) => {
  const home = fake(t);
  await transfer("push", ["-n"]);
  let args = JSON.parse(readFileSync(join(home, "rsync-args")));
  assert.deepEqual(args.slice(-2), [
    `${home}/shared-dev/`,
    "build-box:shared-dev/",
  ]);
  assert.ok(
    args.includes("-avu") && args.includes("--partial") && args.includes("-n"),
  );
  assert.ok(args.includes("--protect-args"));
  assert.match(args[args.indexOf("-e") + 1], /BatchMode=yes/);
  await transfer("pull");
  args = JSON.parse(readFileSync(join(home, "rsync-args")));
  assert.deepEqual(args.slice(-2), [
    "build-box:shared-dev/",
    `${home}/shared-dev/`,
  ]);
  await assert.rejects(transfer("push", ["--delete"]), /never delete/);
  await assert.rejects(transfer("pull", ["; touch evil"]), /Only/);
});

test("missing configuration disables remote helpers and polling before any process starts", async (t) => {
  const home = fake(t);
  env(t, "PI_EXTENSIONS_CONFIG", undefined);
  env(t, "XDG_CONFIG_HOME", join(home, "config"));
  assert.deepEqual(readConfig().remote, {
    host: null,
    project: "~",
    sharedDirectory: "shared-dev",
  });
  for (const operation of [
    () => snapshot(),
    () => listPanes(),
    () => transfer("push"),
    () => transfer("pull"),
    () => startJob("disabled", "task"),
    () => startInteractiveWithTarget("disabled"),
    () => uploadClipboard(),
  ])
    await assert.rejects(operation(), /remote.host/);
  assert.throws(() => attachCommand("$0"), /remote.host/);
  assert.match(attachCommand(remoteTarget), /^ssh -t build-box /);
  const adapter = createDev01Adapter();
  assert.deepEqual(await adapter.list(AbortSignal.timeout(1000)), []);
  assert.equal(adapter.warning(), "");
  assert.deepEqual(dev01Rows(data()), []);
  const result = spawnSync(
    process.execPath,
    [join(root, "bin/dev01.mjs"), "ls"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote.host/);
  for (const file of [
    "ssh-args",
    "rsync-args",
    "tmux-log",
    "clipboard",
    "shared-dev",
  ])
    assert.equal(existsSync(join(home, file)), false, file);
});

test("configured paths expand on each owning host and remain literal through SSH, tmux and rsync", async (t) => {
  const home = fake(t);
  const remoteHome = join(home, "server-home");
  const project = `work/O'Brien $(touch ${home}/injected) #{session_name};`;
  const sharedDirectory = `handoff/O'Brien $(touch ${home}/shared-injected)`;
  mkdirSync(join(remoteHome, project), { recursive: true });
  writeFileSync(join(home, "login-env"), `export HOME=${quote(remoteHome)}\n`);
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({
      remote: {
        host: "operator@build-box.example",
        project: `~/${project}`,
        sharedDirectory: `~/${sharedDirectory}`,
      },
    }),
  );
  const task = "A literal configured task";
  const result = await startJobWithTarget("configured", task);
  assert.match(result.attachCommand, /^ssh -t operator@build-box.example /);
  assert.equal(
    readFileSync(
      join(remoteHome, sharedDirectory, "prompts/configured.md"),
      "utf8",
    ),
    task,
  );
  assert.equal(
    tmuxCalls(home).at(-1)[5],
    `${join(remoteHome, project).replaceAll("#", "##")}/`,
  );
  assert.equal(
    JSON.parse(readFileSync(join(home, "ssh-args"))).at(-2),
    "operator@build-box.example",
  );
  rmSync(join(home, "running"));
  await startInteractiveWithTarget("configured-interactive");
  assert.equal(
    tmuxCalls(home).at(-1)[5],
    `${join(remoteHome, project).replaceAll("#", "##")}/`,
  );
  await transfer("push", ["--dry-run"]);
  const args = JSON.parse(readFileSync(join(home, "rsync-args")));
  assert.ok(args.includes("--protect-args"));
  assert.deepEqual(args.slice(-2), [
    `${join(home, sharedDirectory)}/`,
    `operator@build-box.example:${sharedDirectory}/`,
  ]);
  if (process.platform === "darwin") {
    await uploadClipboard();
    assert.ok(
      readFileSync(join(home, "clipboard"), "utf8").startsWith(
        `${join(remoteHome, sharedDirectory)}/clips/`,
      ),
    );
  }
  assert.equal(existsSync(join(home, "injected")), false);
  assert.equal(existsSync(join(home, "shared-injected")), false);
  assert.equal(existsSync(join(home, "shared-dev")), false);
});

test("a host-only configuration launches in the remote home with default shared storage", async (t) => {
  const home = fake(t);
  const remoteHome = join(home, "server-home");
  mkdirSync(remoteHome);
  writeFileSync(join(home, "login-env"), `export HOME=${quote(remoteHome)}\n`);
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({ remote: { host: "build-box" } }),
  );
  await startJob("home-project", "task");
  assert.equal(tmuxCalls(home).at(-1)[5], `${remoteHome}/`);
  assert.equal(
    readFileSync(
      join(remoteHome, "shared-dev/prompts/home-project.md"),
      "utf8",
    ),
    "task",
  );
  rmSync(join(home, "running"));
  await startInteractiveWithTarget("home-interactive");
  assert.equal(tmuxCalls(home).at(-1)[5], `${remoteHome}/`);
});

test("absolute configured project and shared directories are used without home rebasing", async (t) => {
  const home = fake(t);
  const project = join(home, "absolute project");
  const sharedDirectory = join(home, "absolute exchange");
  mkdirSync(project);
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({ remote: { host: "build-box", project, sharedDirectory } }),
  );
  await startJob("absolute", "task");
  assert.equal(tmuxCalls(home).at(-1)[5], `${project}/`);
  assert.equal(
    readFileSync(join(sharedDirectory, "prompts/absolute.md"), "utf8"),
    "task",
  );
  await transfer("pull");
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "rsync-args"))).slice(-2),
    [`build-box:${sharedDirectory}/`, `${sharedDirectory}/`],
  );
});

test("plain remote scripts retain the default host while an explicit destination stays pinned", async (t) => {
  const home = fake(t);
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({ remote: { host: "other-box" } }),
  );
  assert.equal(
    (await remote("printf pinned", { sshHost: "build-box" })).stdout,
    "pinned",
  );
  assert.equal((await remote("printf current")).stdout, "current");
  const calls = readFileSync(join(home, "ssh-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args.at(-2)),
    ["build-box", "other-box"],
  );
  for (const sshHost of [
    null,
    123,
    "",
    "-oProxyCommand=evil",
    "box other",
    "box\n",
  ]) {
    assert.throws(
      () => remote("printf unsafe", { sshHost }),
      /SSH destination/,
    );
  }
  assert.equal(
    readFileSync(join(home, "ssh-log"), "utf8").trim().split("\n").length,
    2,
  );
});

for (const interactive of [false, true])
  test(`${interactive ? "interactive" : "task-job"} launch results and copied commands keep the launch destination after a config edit`, async (t) => {
    const home = fake(t);
    env(
      t,
      "DEV01_FIXTURE_RECONFIGURE",
      JSON.stringify({ remote: { host: "other-box" } }),
    );
    const result = await (interactive
      ? startInteractiveWithTarget("pinned")
      : startJobWithTarget("pinned", "Only this task"));
    assert.equal(readConfig().remote.host, "other-box");
    assert.deepEqual(result.remoteTmux, remoteTarget);
    assert.equal(result.attachCommand, attachCommand(remoteTarget));
    assert.match(result.attachCommand, /^ssh -t build-box /);
    const calls = () =>
      readFileSync(join(home, "ssh-log"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal(calls().length, 1);
    execFileSync("/bin/sh", ["-c", result.attachCommand]);
    assert.deepEqual(
      calls().map((args) => args.at(-2)),
      ["build-box", "build-box"],
    );
    assert.equal(
      tmuxCalls(home).filter((args) => args[0] === "new-session").length,
      1,
    );
  });

test("snapshot provenance and pane-list commands keep the probed host, not remote-reported or edited config values", async (t) => {
  const home = fake(t);
  writeFileSync(
    join(home, "snapshot.json"),
    JSON.stringify(data({ sshHost: "forged-box" })),
  );
  env(
    t,
    "DEV01_FIXTURE_RECONFIGURE",
    JSON.stringify({ remote: { host: "other-box" } }),
  );
  const value = await snapshot();
  assert.equal(value.sshHost, "build-box");
  assert.equal(readConfig().remote.host, "other-box");
  const [row] = dev01Rows(value);
  assert.deepEqual(row.remoteTmux, remoteTarget);
  assert.match(row.nativeCommand, /^ssh -t build-box /);
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({ remote: { host: "build-box" } }),
  );
  assert.match(await listPanes(), /ssh -t build-box /);
  const calls = readFileSync(join(home, "ssh-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args.at(-2)),
    ["build-box", "build-box"],
  );
});

test("adapter binds Claude, tracked Pi and fallback rows to the actual host while preserving legacy keys across host changes", async (t) => {
  const home = fake(t);
  const base = data().panes[0];
  writeFileSync(
    join(home, "snapshot.json"),
    JSON.stringify(
      data({
        sshHost: "forged-box",
        panes: [
          base,
          { ...base, id: "%1", sessionId: "$1", command: "pi" },
          { ...base, id: "%2", sessionId: "$2", command: "sh" },
        ],
        pi: [
          {
            record: presence({ tmux: { socket: base.socket, pane: "%1" } }),
            pane: "%1",
          },
        ],
      }),
    ),
  );
  env(
    t,
    "DEV01_FIXTURE_RECONFIGURE",
    JSON.stringify({ remote: { host: "other-box" } }),
  );
  const adapter = createDev01Adapter();
  const first = await adapter.list(AbortSignal.timeout(5000));
  const second = await adapter.list(AbortSignal.timeout(5000));
  assert.deepEqual(
    first.map((row) => row.key),
    ["dev01:claude:same-id", "dev01:pi:/remote/session.jsonl", "dev01:tmux:%2"],
  );
  assert.deepEqual(
    second.map((row) => row.key),
    first.map((row) => row.key),
  );
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i].remoteTmux.sshHost, "build-box");
    assert.deepEqual(second[i].remoteTmux, {
      ...first[i].remoteTmux,
      sshHost: "other-box",
    });
    assert.match(first[i].nativeCommand, /^ssh -t build-box /);
    assert.match(second[i].nativeCommand, /^ssh -t other-box /);
  }
  const calls = readFileSync(join(home, "ssh-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args.at(-2)),
    ["build-box", "other-box"],
  );
});

test("unsafe configured SSH destinations fail closed before transport", async (t) => {
  const home = fake(t);
  for (const host of [
    "-oProxyCommand=evil",
    "box;touch evil",
    "box other",
    "box\nother",
  ]) {
    writeFileSync(
      process.env.PI_EXTENSIONS_CONFIG,
      JSON.stringify({ remote: { host } }),
    );
    await assert.rejects(snapshot(), /remote.host/);
    await assert.rejects(startJob("safe", "task"), /remote.host/);
    await assert.rejects(transfer("push"), /remote.host/);
  }
  assert.equal(existsSync(join(home, "ssh-args")), false);
  assert.equal(existsSync(join(home, "rsync-args")), false);
});

test("launch treats shell metacharacters and multiline tasks as data and uses private prompt files", async (t) => {
  const home = fake(t);
  const task = `Summarise 'quotes' and $(touch ${home}/injected).\n\"; exit 7; #\n`;
  const result = await startJob("pr-summary", task);
  assert.match(result, /Started Claude job/);
  assert.equal(
    readFileSync(join(home, "shared-dev/prompts/pr-summary.md"), "utf8"),
    task,
  );
  assert.equal(
    statSync(join(home, "shared-dev/prompts/pr-summary.md")).mode & 0o777,
    0o600,
  );
  assert.equal(existsSync(join(home, "injected")), false);
  const sshArgs = JSON.parse(readFileSync(join(home, "ssh-args")));
  assert.ok(sshArgs.includes("BatchMode=yes"));
  assert.ok(!sshArgs.at(-1).includes(task));
  const calls = readFileSync(join(home, "tmux-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls.at(-1), [
    "new-session",
    "-d",
    "-s",
    "pr-summary",
    "-c",
    `${home}/work/project/`,
    "-P",
    "-F",
    "#{socket_path}\t#{session_id}\t#{pane_id}",
    `${home}/bin/claude`,
    `Do the task in ${home}/shared-dev/prompts/pr-summary.md`,
  ]);
  await assert.rejects(startJob("pr-summary", "replacement"), /already exists/);
  assert.equal(
    readFileSync(join(home, "shared-dev/prompts/pr-summary.md"), "utf8"),
    task,
  );
  assert.equal(
    existsSync(join(home, "shared-dev/prompts/.pr-summary.lock")),
    false,
  );
});

for (const [agent, label] of [
  ["pi", "Pi"],
  ["claude", "Claude"],
  ["codex", "Codex"],
]) {
  test(`${agent} launches from CLI and Pi with remote defaults and literal task data`, async (t) => {
    const h = await harness(t);
    const home = h.home;
    const task = `Keep  spaces, 'quotes', --agent claude and $(touch ${home}/injected).\nSecond line.\n`;
    const cli = execFileSync(
      process.execPath,
      [join(root, "bin/dev01.mjs"), "run", "--agent", agent, "cli-job", task],
      { encoding: "utf8" },
    );
    assert.match(cli, new RegExp(`Started ${label} job`));
    assert.equal(
      readFileSync(join(home, "shared-dev/prompts/cli-job.md"), "utf8"),
      task,
    );
    rmSync(join(home, "running"));
    await h.command("devrun", ` --agent ${agent} pi-job ${task}`);
    assert.deepEqual(h.notices, []);
    assert.match(
      h.messages[0].message.content,
      new RegExp(`Started ${label} job`),
    );
    assert.equal(h.messages[0].options.triggerTurn, false);
    assert.equal(
      readFileSync(join(h.home, "shared-dev/prompts/pi-job.md"), "utf8"),
      task,
    );
    const calls = readFileSync(join(home, "tmux-log"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      calls.filter((args) => args[0] === "new-session"),
      ["cli-job", "pi-job"].map((name) => [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        `${home}/work/project/`,
        "-P",
        "-F",
        "#{socket_path}\t#{session_id}\t#{pane_id}",
        `${home}/bin/${agent}`,
        `Do the task in ${home}/shared-dev/prompts/${name}.md`,
      ]),
    );
    assert.equal(existsSync(join(home, "injected")), false);
  });

  test(`missing ${agent} fails before uploading a prompt`, async (t) => {
    const home = fake(t);
    rmSync(join(home, "bin", agent));
    await assert.rejects(
      startJob("missing", "task", { agent }),
      new RegExp(`${agent} is not installed on dev01`),
    );
    assert.equal(existsSync(join(home, "shared-dev")), false);
    assert.equal(existsSync(join(home, "tmux-log")), false);
  });
}

for (const agent of ["pi", "claude", "codex"]) {
  test(`task-job ${agent} launcher returns atomic remote identity without forwarding conversation state`, async (t) => {
    const home = fake(t);
    const task = "Only this explicit task.\nKeep --agent claude literal.";
    const result = await startJobWithTarget("dashboard-job", task, {
      agent,
      // Fixture subprocesses can queue behind concurrent test workers.
      signal: AbortSignal.timeout(10_000),
    });
    assert.match(result.message, /not a completion report/);
    assert.equal(result.attachCommand, attachCommand(remoteTarget));
    assert.deepEqual(result.remoteTmux, remoteTarget);
    assert.equal(result.tmux, undefined);
    assert.equal(
      readFileSync(join(home, "shared-dev/prompts/dashboard-job.md"), "utf8"),
      task,
    );
    const calls = readFileSync(join(home, "tmux-log"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.at(-1)[9], `${home}/bin/${agent}`);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["has-session", "new-session"],
    );
  });
}

test("launch returns the exact atomic tmux identity without a follow-up lookup", async (t) => {
  const home = fake(t);
  const target = {
    ...remoteTarget,
    socket: `/remote/O'Brien $(touch ${home}/injected),socket`,
    session: "$73",
    pane: "%108",
  };
  env(
    t,
    "DEV01_FIXTURE_IDENTITY",
    `${target.socket}\t${target.session}\t${target.pane}\n`,
  );
  const result = await startJobWithTarget("not-the-session-id", "task", {
    agent: "pi",
  });
  assert.deepEqual(result.remoteTmux, target);
  assert.equal(result.attachCommand, attachCommand(target));
  assert.match(result.message, /Started Pi job/);
  assert.equal(existsSync(join(home, "running")), true);
  const calls = readFileSync(join(home, "tmux-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["has-session", "new-session"],
  );
  execFileSync("/bin/sh", ["-c", result.attachCommand]);
  const attach = readFileSync(join(home, "tmux-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .at(-1);
  assert.deepEqual(attach, remoteTmuxAttachArgs(target));
  assert.match(
    attach[7],
    /select-window -t %108 ; select-pane -t %108 ; attach-session -t '\$73'/,
  );
  assert.equal(existsSync(join(home, "injected")), false);
});

for (const [label, identity] of [
  ["empty response", ""],
  ["missing pane", "/remote/socket\t$0\n"],
  ["relative socket", "relative/socket\t$0\t%0\n"],
  ["unsafe socket", "/remote/\u202esocket\t$0\t%0\n"],
  ["oversized socket", `/${"x".repeat(4096)}\t$0\t%0\n`],
  ["named session", "/remote/socket\tjob\t%0\n"],
  ["named pane", "/remote/socket\t$0\tjob\n"],
  ["extra field", "/remote/socket\t$0\t%0\textra\n"],
  ["extra line", "notice\n/remote/socket\t$0\t%0\n"],
  ["extra newline", "/remote/socket\t$0\t%0\n\n"],
  [
    "command instead of identity",
    "ssh -t build-box 'tmux attach-session -t job'\n",
  ],
])
  for (const interactive of [false, true]) {
    test(`${interactive ? "interactive" : "task-job"} launch rejects ${label} and warns the session may have started`, async (t) => {
      const home = fake(t);
      env(t, "DEV01_FIXTURE_IDENTITY", identity);
      await assert.rejects(
        interactive
          ? startInteractiveWithTarget("uncertain", {
              signal: AbortSignal.timeout(10_000),
            })
          : startJobWithTarget("uncertain", "task", {
              agent: "pi",
              signal: AbortSignal.timeout(10_000),
            }),
        /valid socket path, session ID and pane ID\.[\s\S]*Launch may have reached dev01/,
      );
      assert.equal(existsSync(join(home, "running")), true);
      const calls = readFileSync(join(home, "tmux-log"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(calls.filter((args) => args[0] === "new-session").length, 1);
    });
  }

function tmuxCalls(home) {
  return readFileSync(join(home, "tmux-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}
function assertNoPromptUpload(home) {
  assert.equal(readFileSync(join(home, "ssh-input")).length, 0);
  assert.equal(existsSync(join(home, "shared-dev")), false);
}

for (const [agent, label] of [
  ["pi", "Pi"],
  ["claude", "Claude"],
  ["codex", "Codex"],
]) {
  test(`interactive ${agent} uses login PATH, no agent arguments or prompt, and an atomic guarded attach target`, async (t) => {
    const home = fake(t);
    const target = {
      ...remoteTarget,
      socket: `/remote/O'Brien $(touch ${home}/injected),socket`,
      session: "$73",
      pane: "%108",
    };
    env(
      t,
      "DEV01_FIXTURE_IDENTITY",
      `${target.socket}\t${target.session}\t${target.pane}`,
    );
    const result = await startInteractiveWithTarget("agent-deadbeef", {
      agent,
    });
    assert.deepEqual(Object.keys(result).sort(), [
      "attachCommand",
      "message",
      "remoteTmux",
    ]);
    assert.deepEqual(result.remoteTmux, target);
    assert.equal(result.attachCommand, attachCommand(target));
    assert.match(
      result.message,
      new RegExp(`Started ${label} session agent-deadbeef on dev01`),
    );
    assert.match(result.message, /readiness is not confirmed/);
    assertNoPromptUpload(home);
    assert.deepEqual(tmuxCalls(home), [
      ["has-session", "-t", "=agent-deadbeef"],
      [
        "new-session",
        "-d",
        "-s",
        "agent-deadbeef",
        "-c",
        `${home}/work/project/`,
        "-P",
        "-F",
        "#{socket_path}\t#{session_id}\t#{pane_id}",
        "/usr/bin/env",
        ...freshAgentVariables.flatMap((key) => ["-u", key]),
        `PATH=${home}/bin:/usr/bin:/bin`,
        `${home}/bin/${agent}`,
        ";",
        "set-option",
        "-w",
        "-t",
        "=agent-deadbeef:",
        "remain-on-exit",
        "failed",
        ";",
        "set-option",
        "-w",
        "-t",
        "=agent-deadbeef:",
        "@pi-agents-agent",
        agent,
      ],
    ]);
    const sshArgs = JSON.parse(readFileSync(join(home, "ssh-args")));
    assert.ok(sshArgs.includes("BatchMode=yes"));
    assert.match(sshArgs.at(-1), /^bash -lc /);
    execFileSync("/bin/sh", ["-c", result.attachCommand]);
    assert.deepEqual(tmuxCalls(home).at(-1), remoteTmuxAttachArgs(target));
    assert.equal(existsSync(join(home, "injected")), false);
  });
}

test("interactive defaults to Pi without options", async (t) => {
  const home = fake(t);
  const result = await startInteractiveWithTarget("default");
  assert.match(result.message, /Started Pi session/);
  const args = tmuxCalls(home).at(-1);
  assert.equal(args[args.indexOf(";") - 1], `${home}/bin/pi`);
  assertNoPromptUpload(home);
});

test("interactive paths expand only remote HOME and resolve the remote login executable", async (t) => {
  const home = fake(t);
  const remoteHome = join(home, "remote-home");
  const loginBin = join(remoteHome, "O'Brien login bin");
  mkdirSync(loginBin, { recursive: true });
  symlinkSync(join(home, "bin/pi"), join(loginBin, "pi"));
  const loginPath = `${loginBin}:${home}/bin:/usr/bin:/bin`;
  writeFileSync(
    join(home, "login-env"),
    `export HOME=${quote(remoteHome)}\nexport PATH=${quote(loginPath)}\n`,
  );
  const literal = `O'Brien \"quoted\" $(touch ${home}/injected) \`touch ${home}/backtick\` $HOME * ? [x] #{session_name} \\;`;
  const projects = [
    ["~/work/project", join(remoteHome, "work/project")],
    ["work/project", join(remoteHome, "work/project")],
    ["./work/project", `${remoteHome}/./work/project`],
    ["~", remoteHome],
    [".", `${remoteHome}/.`],
    [join(home, "absolute project"), join(home, "absolute project")],
    [`~/${literal}`, `${remoteHome}/${literal}`],
    [literal, `${remoteHome}/${literal}`],
    ["$HOME/literal", `${remoteHome}/$HOME/literal`],
    ["~someone/literal", `${remoteHome}/~someone/literal`],
  ];
  for (const [cwd, expected] of projects) {
    mkdirSync(expected, { recursive: true });
    await startInteractiveWithTarget("literal", { cwd });
    const args = tmuxCalls(home).at(-1);
    assert.equal(args[5], `${expected.replaceAll("#", "##")}/`);
    assert.equal(args[args.indexOf(";") - 1], join(loginBin, "pi"));
    assert.ok(args.includes(`PATH=${loginPath}`));
    assertNoPromptUpload(home);
    rmSync(join(home, "running"));
  }
  assert.equal(existsSync(join(home, "injected")), false);
  assert.equal(existsSync(join(home, "backtick")), false);
});

test("interactive rejects invalid names, agents and project controls before SSH", async (t) => {
  const home = fake(t);
  for (const name of [
    undefined,
    null,
    1,
    {},
    "",
    "../escape",
    "-option",
    "UPPER",
    "bad name",
    "x;touch evil",
    "x\n",
    "a".repeat(65),
  ])
    await assert.rejects(startInteractiveWithTarget(name), /Session name/);
  for (const agent of [
    null,
    1,
    {},
    "",
    "bash",
    "pi --model other",
    "$(touch evil)",
    "pi\n",
  ])
    await assert.rejects(
      startInteractiveWithTarget("valid", { agent }),
      /Unknown agent/,
    );
  for (const cwd of [
    null,
    1,
    {},
    "",
    "   ",
    ...[
      "\0",
      "\n",
      "\r",
      "\t",
      "\x7f",
      "\x85",
      "\u2028",
      "\u2029",
      "\u202e",
      "\u2066",
    ].map((c) => `project${c}other`),
  ])
    await assert.rejects(
      startInteractiveWithTarget("valid", { cwd }),
      /remote project path/,
    );
  const signal = AbortSignal.abort();
  await assert.rejects(
    startInteractiveWithTarget("valid", { signal }),
    /abort/i,
  );
  assert.equal(existsSync(join(home, "ssh-args")), false);
  assert.equal(existsSync(join(home, "tmux-log")), false);
});

test("interactive missing or non-directory projects fail remotely without creating anything", async (t) => {
  const home = fake(t);
  const remoteHome = join(home, "remote-home");
  mkdirSync(remoteHome);
  writeFileSync(join(home, "login-env"), `export HOME=${quote(remoteHome)}\n`);
  writeFileSync(join(remoteHome, "file"), "not a directory");
  for (const cwd of ["missing", "work/project", "~/work/project", "file"]) {
    await assert.rejects(
      startInteractiveWithTarget("missing-project", { cwd }),
      /Remote project is not a directory/,
    );
    assertNoPromptUpload(home);
  }
  assert.equal(existsSync(join(home, "tmux-log")), false);
  assert.equal(existsSync(join(home, "running")), false);
});

for (const executable of ["pi", "claude", "codex", "tmux"])
  test(`interactive missing ${executable} fails before session creation or upload`, async (t) => {
    const home = fake(t);
    rmSync(join(home, "bin", executable));
    await assert.rejects(
      startInteractiveWithTarget("missing", {
        agent: executable === "tmux" ? "pi" : executable,
      }),
      new RegExp(`${executable} is not installed on dev01`),
    );
    assertNoPromptUpload(home);
    assert.equal(existsSync(join(home, "tmux-log")), false);
  });

for (const executable of ["pi", "tmux"])
  test(`interactive refuses a shell function instead of an absolute ${executable} executable`, async (t) => {
    const home = fake(t);
    const startup = join(home, "bash-env");
    writeFileSync(startup, `${executable}() { :; }\n`);
    env(t, "BASH_ENV", startup);
    await assert.rejects(
      startInteractiveWithTarget("not-executable"),
      new RegExp(`${executable} is not an executable`),
    );
    assertNoPromptUpload(home);
    assert.equal(existsSync(join(home, "tmux-log")), false);
  });

test("interactive collisions preserve existing sessions, including a race after has-session", async (t) => {
  const home = fake(t);
  writeFileSync(join(home, "running"), "existing session");
  await assert.rejects(
    startInteractiveWithTarget("same-name"),
    /already exists/,
  );
  assert.equal(readFileSync(join(home, "running"), "utf8"), "existing session");
  assert.equal(
    tmuxCalls(home).filter((args) => args[0] === "new-session").length,
    0,
  );
  rmSync(join(home, "running"));
  env(t, "DEV01_FIXTURE_COLLIDE", "1");
  await assert.rejects(
    startInteractiveWithTarget("same-name"),
    /duplicate session[\s\S]*Check devls before retrying/,
  );
  assert.equal(readFileSync(join(home, "running"), "utf8"), "racing session");
  assert.equal(
    tmuxCalls(home).filter((args) => args[0] === "new-session").length,
    1,
  );
  assertNoPromptUpload(home);
});

test("simultaneous interactive launches create at most one session", async (t) => {
  const home = fake(t);
  const results = await Promise.allSettled([
    startInteractiveWithTarget("same-name"),
    startInteractiveWithTarget("same-name"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /already exists|duplicate session/,
  );
  assert.equal(readFileSync(join(home, "running"), "utf8"), "yes");
  assertNoPromptUpload(home);
});

for (const [condition, message] of [
  ["FAIL", /offline/],
  ["TMUX_FAIL", /fixture tmux refused/],
  ["HANG", /cancelled/],
])
  test(`interactive ${condition} warns of an uncertain launch without retrying`, async (t) => {
    const home = fake(t);
    env(t, `DEV01_FIXTURE_${condition}`, "1");
    await assert.rejects(
      startInteractiveWithTarget("uncertain", {
        signal: condition === "HANG" ? AbortSignal.timeout(300) : undefined,
      }),
      (error) => {
        assert.match(error.message, message);
        assert.match(
          error.message,
          /Launch may have reached dev01\. Check devls before retrying/,
        );
        return true;
      },
    );
    assert.equal(
      readFileSync(join(home, "ssh-log"), "utf8").trim().split("\n").length,
      1,
    );
    assert.equal(existsSync(join(home, "running")), false);
    assertNoPromptUpload(home);
  });

for (const [agent, fail] of [
  ["pi", false],
  ["pi", true],
  ["claude", true],
  ["codex", true],
])
  test(
    `real private tmux interactive ${agent} ${fail ? "retains startup failure" : "stays interactive"} with fresh context and literal paths`,
    { skip: !realTmux, timeout: 15_000 },
    async (t) => {
      const home = fake(t);
      const remoteHome = join(home, "remote-home");
      const loginBin = join(remoteHome, "O'Brien #{session_name} bin");
      const cwd = `O'Brien \"quoted\" $(touch ${home}/injected) \`touch ${home}/backtick\` $HOME * ? [x] #{session_name} \\;`;
      const project = join(remoteHome, cwd);
      mkdirSync(project, { recursive: true });
      mkdirSync(loginBin, { recursive: true });
      const loginPath = `${loginBin}:${home}/bin:/usr/bin:/bin:${home}/path;`;
      writeFileSync(
        join(home, "login-env"),
        `export HOME=${quote(remoteHome)}\nexport PATH=${quote(loginPath)}\n`,
      );
      writeFileSync(
        join(loginBin, agent),
        `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(home, "agent.json"))}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH, env: Object.fromEntries(${JSON.stringify(freshAgentVariables)}.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))})); console.log('fixture interactive ready'); ${fail ? "console.error('fixture startup failed'); process.exit(17);" : "setInterval(() => {}, 1000);"}\n`,
        { mode: 0o700 },
      );
      const socket = join(home, "s");
      writeFileSync(
        join(home, "bin/tmux"),
        `#!${process.execPath}\nconst cp = require('node:child_process'); const r = cp.spawnSync(${JSON.stringify(realTmux)}, ['-S', ${JSON.stringify(socket)}, '-f', '/dev/null', ...process.argv.slice(2)], { env: { ...process.env, TMUX: '', TMUX_PANE: '' }, stdio: 'inherit' }); process.exit(r.status ?? 1);\n`,
        { mode: 0o700 },
      );
      const tmux = (...args) =>
        execFileSync(realTmux, ["-S", socket, ...args], { encoding: "utf8" });
      for (const key of freshAgentVariables) env(t, key, "inherited-parent");
      try {
        // A pre-existing server has a stale PATH and stale parent session variables.
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
            "keeper",
            "/bin/sleep",
            "60",
          ],
          {
            env: {
              ...process.env,
              PATH: "/usr/bin:/bin",
              TMUX: "",
              TMUX_PANE: "",
            },
          },
        );
        const result = await startInteractiveWithTarget("agent-deadbeef", {
          agent,
          cwd,
        });
        const target = result.remoteTmux;
        assert.equal(target.host, "dev01");
        assert.equal(target.sshHost, "build-box");
        assert.equal(result.attachCommand, attachCommand(target));
        assert.deepEqual(
          tmux(
            "display-message",
            "-p",
            "-t",
            target.pane,
            "#{socket_path}\t#{session_id}\t#{pane_id}",
          )
            .trim()
            .split("\t"),
          [target.socket, target.session, target.pane],
        );
        let state;
        for (let i = 0; i < 100; i++) {
          state = tmux(
            "display-message",
            "-p",
            "-t",
            target.pane,
            "#{pane_dead}:#{pane_dead_status}",
          ).trim();
          if (
            existsSync(join(home, "agent.json")) &&
            (!fail || state === "1:17")
          )
            break;
          await new Promise((done) => setTimeout(done, 25));
        }
        assert.match(state, fail ? /^1:17$/ : /^0:/);
        const record = JSON.parse(
          readFileSync(join(home, "agent.json"), "utf8"),
        );
        assert.deepEqual(record.args, []);
        assert.deepEqual(record.env, {});
        assert.equal(record.path, loginPath);
        assert.equal(record.cwd, realpathSync(project));
        assert.equal(
          tmux(
            "show-options",
            "-wv",
            "-t",
            `${target.session}:`,
            "remain-on-exit",
          ).trim(),
          "failed",
        );
        assert.equal(
          tmux(
            "show-options",
            "-wv",
            "-t",
            `${target.session}:`,
            "@pi-agents-agent",
          ).trim(),
          agent,
        );
        const output = tmux("capture-pane", "-p", "-S", "-", "-t", target.pane);
        assert.match(
          output,
          fail ? /fixture startup failed/ : /fixture interactive ready/,
        );
        await assert.rejects(
          startInteractiveWithTarget("agent-deadbeef", { agent, cwd }),
          /already exists/,
        );
        assert.equal(
          tmux(
            "display-message",
            "-p",
            "-t",
            target.pane,
            "#{session_id}:#{pane_id}",
          ).trim(),
          `${target.session}:${target.pane}`,
        );
        assert.equal(
          tmux("capture-pane", "-p", "-S", "-", "-t", target.pane),
          output,
        );
        assert.equal(existsSync(join(home, "injected")), false);
        assert.equal(existsSync(join(home, "backtick")), false);
        assert.equal(existsSync(join(remoteHome, "shared-dev")), false);
        assertNoPromptUpload(home);
      } finally {
        spawnSync(realTmux, ["-S", socket, "kill-server"]);
      }
    },
  );

test("run syntax rejects unknown agents and malformed headers before SSH", async (t) => {
  const home = fake(t);
  for (const args of [
    [],
    ["--agent"],
    ["--agent", "pi"],
    ["--agent", "pi", "job"],
    ["--agent", "pi", "job", "  "],
    ["--agent", "other", "job", "task"],
    ["--agent", "$(touch evil)", "job", "task"],
    ["--model", "opus", "job", "task"],
    ["--agent=pi", "job", "task"],
    ["--agent", "pi", "--agent", "codex", "job", "task"],
  ]) {
    for (const input of [args, args.join(" ")]) {
      await assert.rejects(async () => runJob(input), /Usage|Unknown agent/);
    }
  }
  await assert.rejects(runJob(["bad name", "task"]), /Usage/);
  assert.equal(existsSync(join(home, "ssh-args")), false);
});

test("bare devrun keeps Claude and accepts flag-like task text", async (t) => {
  const home = fake(t);
  const task = "--agent codex is literal task text";
  assert.match(await runJob(["default-cli", task]), /Started Claude job/);
  assert.equal(
    readFileSync(join(home, "shared-dev/prompts/default-cli.md"), "utf8"),
    task,
  );
  rmSync(join(home, "running"));
  assert.match(await runJob(`default-pi ${task}`), /Started Claude job/);
  assert.equal(
    readFileSync(join(home, "shared-dev/prompts/default-pi.md"), "utf8"),
    task,
  );
});

test("invalid names never reach SSH, and an occupied launch lock preserves the task", async (t) => {
  const home = fake(t);
  for (const name of [
    "",
    "../escape",
    "-option",
    "UPPER",
    "x;touch evil",
    "a".repeat(65),
  ])
    await assert.rejects(startJob(name, "task"), /Usage/);
  await assert.rejects(startJob("valid", "  "), /Usage/);
  assert.equal(existsSync(join(home, "ssh-args")), false);
  mkdirSync(join(home, "shared-dev/prompts/.locked.lock"), { recursive: true });
  await assert.rejects(startJob("locked", "task"), /Another launch/);
  assert.equal(existsSync(join(home, "shared-dev/prompts/locked.md")), false);
});

test("simultaneous launches cannot overwrite the same prompt", async (t) => {
  const home = fake(t);
  const results = await Promise.allSettled([
    startJob("same-name", "first task"),
    startJob("same-name", "second task"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const winner = results.findIndex((result) => result.status === "fulfilled");
  assert.equal(
    readFileSync(join(home, "shared-dev/prompts/same-name.md"), "utf8"),
    winner === 0 ? "first task" : "second task",
  );
});

test("truncated task uploads never launch Claude", async (t) => {
  const home = fake(t);
  env(t, "DEV01_FIXTURE_TRUNCATE", "1");
  await assert.rejects(
    startJob("partial", "Do not launch a partial task"),
    /Incomplete task upload/,
  );
  assert.equal(existsSync(join(home, "running")), false);
  assert.equal(existsSync(join(home, "shared-dev/prompts/partial.md")), false);
});

test("SSH failure is not an empty list or successful launch; launch is never retried", async (t) => {
  fake(t);
  env(t, "DEV01_FIXTURE_FAIL", "1");
  await assert.rejects(listPanes(), /offline/);
  await assert.rejects(
    startJob("check", "task"),
    /Check devls before retrying/,
  );
});

test("attach command survives shell quoting and targets the existing tmux session", (t) => {
  const home = fake(t);
  execFileSync("/bin/sh", ["-c", attachCommand("$0")]);
  const args = JSON.parse(readFileSync(join(home, "tmux-log"), "utf8").trim());
  assert.deepEqual(args, ["attach-session", "-t", "$0"]);
  assert.throws(() => attachCommand("$(touch evil)"));
});

test(
  "clipboard upload copies only the remote path, and no-image failure never reaches SSH",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = fake(t);
    assert.match(await uploadClipboard(), /Path copied:/);
    const path = readFileSync(join(home, "clipboard"), "utf8");
    assert.match(path, /shared-dev\/clips\/clip-[a-f0-9-]+\.png$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    rmSync(join(home, "ssh-args"));
    env(t, "DEV01_FIXTURE_NO_IMAGE", "1");
    await assert.rejects(uploadClipboard(), /osascript failed/);
    assert.equal(existsSync(join(home, "ssh-args")), false);
  },
);

test(
  "clipboard upload keeps its destination snapshot when config changes during extraction",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = fake(t);
    env(
      t,
      "DEV01_FIXTURE_CLIPBOARD_RECONFIGURE",
      JSON.stringify({
        remote: { host: "other-box", sharedDirectory: "other-exchange" },
      }),
    );
    assert.match(await uploadClipboard(), /Path copied:/);
    assert.equal(readConfig().remote.host, "other-box");
    assert.equal(readConfig().remote.sharedDirectory, "other-exchange");
    const calls = readFileSync(join(home, "ssh-log"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      calls.map((args) => args.at(-2)),
      ["build-box"],
    );
    const path = readFileSync(join(home, "clipboard"), "utf8");
    assert.ok(path.startsWith(`${home}/shared-dev/clips/`), path);
    assert.deepEqual(
      readFileSync(path),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(existsSync(join(home, "other-exchange")), false);
  },
);

test("aborting a helper rejects promptly, even if it ignores SIGTERM", async (t) => {
  fake(t);
  env(t, "DEV01_FIXTURE_HANG", "1");
  await assert.rejects(snapshot(AbortSignal.timeout(200)), /cancelled/);
  await assert.rejects(
    runJob("--agent pi cancelled task", AbortSignal.timeout(200)),
    /cancelled/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 100,
    }),
    /failed/,
  );
});

test("probe is read-only, matches process ancestry and ignores dead or unsafe Pi records", (t) => {
  const home = fake(t);
  const registry = join(home, "pi-status/agents-status");
  mkdirSync(registry, { recursive: true });
  env(t, "PI_CODING_AGENT_DIR", join(home, "pi-status"));
  writeFileSync(
    join(home, "claude.json"),
    JSON.stringify([
      { sessionId: "real", pid: process.pid, cwd: "/remote", status: "busy" },
    ]),
  );
  writeFileSync(join(registry, "aa.json"), JSON.stringify(presence()));
  writeFileSync(
    join(registry, "bb.json"),
    JSON.stringify(presence({ pid: 999999999 })),
  );
  writeFileSync(join(registry, "cc.json"), "x".repeat(20_000));
  symlinkSync(join(registry, "aa.json"), join(registry, "dd.json"));
  const result = JSON.parse(
    execFileSync(python, [join(root, "bin/dev01-status.py")], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.panes[0].socket, remoteTarget.socket);
  const calls = readFileSync(join(home, "tmux-log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.match(calls[0].at(-1), /#\{socket_path\}/);
  assert.equal(result.claude[0].pane, "%0");
  assert.equal(result.pi.length, 1);
  assert.equal(result.pi[0].pane, "%0");
  assert.equal(result.version, 1);
  assert.ok(result.now > 0);
});

test("probe ancestry does not give headless Pi children their parent's terminal", (t) => {
  const home = fake(t);
  const registry = join(home, "pi-status/agents-status");
  mkdirSync(registry, { recursive: true });
  env(t, "PI_CODING_AGENT_DIR", join(home, "pi-status"));
  writeFileSync(
    join(home, "bin/ps"),
    `#!${process.execPath}\nconsole.log('${process.pid} ${process.ppid}\\n${process.ppid} 201\\n201 1');`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(registry, "aa.json"),
    JSON.stringify(presence({ pid: process.ppid, heartbeat: Date.now() })),
  );
  writeFileSync(
    join(registry, "bb.json"),
    JSON.stringify(
      presence({
        instance: "child",
        sessionFile: "/remote/child.jsonl",
        tmux: undefined,
        status: "working",
        heartbeat: Date.now(),
      }),
    ),
  );
  for (const parentPresent of [true, false]) {
    if (!parentPresent) rmSync(join(registry, "aa.json"));
    const result = JSON.parse(
      execFileSync(python, [join(root, "bin/dev01-status.py")], {
        encoding: "utf8",
      }),
    );
    assert.equal(result.pi.length, parentPresent ? 2 : 1);
    assert.ok(result.pi.every((entry) => entry.pane === "%0"));
    const rows = dev01Rows({ ...result, sshHost: "build-box" });
    const child = rows.find(
      (row) => row.key === "dev01:pi:/remote/child.jsonl",
    );
    assert.equal(child.status, "working");
    assert.equal(child.remoteTmux, undefined);
    assert.equal(child.nativeCommand, undefined);
    assert.equal(rows.length, 2);
    const terminal = rows.find((row) => row !== child);
    assert.equal(
      terminal.key,
      parentPresent ? "dev01:pi:/remote/session.jsonl" : "dev01:tmux:%0",
    );
    assert.deepEqual(terminal.remoteTmux, remoteTarget);
  }
});

for (const failure of [
  "missing-claude",
  "invalid-claude",
  "missing-tmux",
  "unreadable-pi",
]) {
  test(`probe isolates ${failure} without hiding healthy sources`, (t) => {
    const home = fake(t);
    const registry = join(home, "status/agents-status");
    env(t, "PI_CODING_AGENT_DIR", join(home, "status"));
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "aa.json"), JSON.stringify(presence()));
    if (failure === "missing-claude") rmSync(join(home, "bin/claude"));
    if (failure === "invalid-claude")
      writeFileSync(join(home, "claude.json"), "not JSON");
    if (failure === "missing-tmux") rmSync(join(home, "bin/tmux"));
    if (failure === "unreadable-pi") {
      rmSync(registry, { recursive: true });
      writeFileSync(registry, "not a directory");
    }
    const result = JSON.parse(
      execFileSync(python, [join(root, "bin/dev01-status.py")], {
        encoding: "utf8",
      }),
    );
    const source = failure.endsWith("claude")
      ? "claude"
      : failure.endsWith("tmux")
        ? "tmux"
        : "pi";
    assert.deepEqual(result.errors, [source]);
    if (source !== "pi") assert.equal(result.pi.length, 1);
    if (source !== "tmux") assert.equal(result.panes.length, 1);
    assert.equal(result.version, 1);
  });
}

for (const source of ["claude", "pi", "tmux"]) {
  test(`adapter retains only ${source} as Unknown during a partial outage and recovers`, async (t) => {
    const home = fake(t);
    const base = data().panes[0];
    const initial = data({
      panes: [
        base,
        { ...base, id: "%1", sessionId: "$1", command: "pi" },
        { ...base, id: "%2", sessionId: "$2", command: "sh" },
      ],
      pi: [
        {
          record: presence({ tmux: { socket: base.socket, pane: "%1" } }),
          pane: "%1",
        },
      ],
    });
    const file = join(home, "snapshot.json");
    writeFileSync(file, JSON.stringify(initial));
    const adapter = createDev01Adapter();
    const signal = AbortSignal.timeout(5_000);
    const first = await adapter.list(signal);
    assert.equal(first.length, 3);
    assert.ok(first.every((row) => row.remoteTmux));
    const field = source === "tmux" ? "panes" : source;
    // A source failure must preserve the last known row without an attach target.
    // Keep unrelated panes healthy without manufacturing a fallback for this source.
    const panes = initial.panes.filter((pane) =>
      source === "claude"
        ? pane.id !== "%0"
        : source === "pi"
          ? pane.id !== "%1"
          : false,
    );
    writeFileSync(
      file,
      JSON.stringify({ ...initial, panes, [field]: [], errors: [source] }),
    );
    const rows = await adapter.list(signal);
    assert.equal(rows.length, 3);
    const stale = rows.find((row) => row.key.startsWith(`dev01:${source}:`));
    assert.equal(stale.status, "unknown");
    assert.equal(stale.nativeCommand, undefined);
    assert.equal(stale.remoteTmux, undefined);
    assert.equal(stale.live, false);
    assert.match(adapter.warning(), new RegExp(source));
    const healthy = rows.filter((row) => row !== stale);
    assert.ok(healthy.every((row) => row.live));
    if (source === "tmux") assert.ok(rows.every((row) => !row.remoteTmux));
    writeFileSync(
      file,
      JSON.stringify(data({ panes: [], claude: [], pi: [] })),
    );
    assert.deepEqual(await adapter.list(signal), []);
    assert.equal(adapter.warning(), "");
  });
}

test("unsupported Claude records preserve remote Pi and tmux and surface a partial warning", async (t) => {
  const home = fake(t);
  writeFileSync(
    join(home, "snapshot.json"),
    JSON.stringify(
      data({
        claude: [{ record: [] }],
        pi: [{ record: presence(), pane: "%0" }],
      }),
    ),
  );
  const adapter = createDev01Adapter();
  const rows = await adapter.list(AbortSignal.timeout(2_000));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "pi");
  assert.match(adapter.warning(), /claude/);
  const sessions = new ExternalSessions([adapter], () => {});
  t.after(() => sessions.dispose());
  sessions.start();
  for (let i = 0; i < 100 && !sessions.summary.includes("unavailable"); i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.match(sessions.summary, /dev01 unavailable: claude/);
  assert.equal(sessions.rows[0].source, "pi");
});

test("a failed tmux probe cannot report no sessions", async (t) => {
  const home = fake(t);
  writeFileSync(
    join(home, "snapshot.json"),
    JSON.stringify(data({ panes: [], errors: ["tmux"] })),
  );
  await assert.rejects(listPanes(), /not an empty session list/);
});

test("remote Claude is host-namespaced, deduplicated against tmux and never gets a local attach command", () => {
  const [row] = dev01Rows(data());
  assert.equal(row.key, "dev01:claude:same-id");
  assert.equal(row.host, "dev01");
  assert.equal(row.cwd, "/remote/project");
  assert.equal(row.status, "working");
  assert.equal(row.nativeCommand, attachCommand(remoteTarget));
  assert.deepEqual(row.remoteTmux, remoteTarget);
  assert.equal(row.sessionFile, undefined);
  assert.equal(dev01Rows(data()).length, 1);
});

test("remote Pi never resolves paths locally, uses remote time and guards duplicate owners", (t) => {
  const directory = temporary(t);
  const alias = join(directory, "alias");
  symlinkSync(directory, alias);
  const input = data({
    claude: [],
    now: 100_000,
    pi: [{ record: presence({ cwd: alias, pid: 999999999 }), pane: "%0" }],
  });
  let [row] = dev01Rows(input);
  assert.equal(row.cwd, alias);
  assert.equal(row.status, "ready", "remote clock, not the Mac clock");
  assert.equal(row.sessionFile, undefined);
  assert.deepEqual(row.owners, []);
  assert.equal(row.current, false);
  assert.deepEqual(row.remoteTmux, remoteTarget);
  assert.equal(row.nativeCommand, attachCommand(remoteTarget));
  input.pi[0].record.heartbeat = 1;
  const [stale] = dev01Rows(input);
  assert.equal(stale.status, "unknown");
  assert.equal(stale.remoteTmux, undefined);
  assert.equal(stale.nativeCommand, undefined);
  input.pi.push({ record: presence({ instance: "other" }), pane: "%0" });
  [row] = dev01Rows(input);
  assert.equal(row.status, "unknown");
  assert.equal(row.nativeCommand, undefined);
  assert.equal(row.remoteTmux, undefined);
  assert.equal(dev01Rows(input).length, 1);
});

test("duplicate remote Pi owners consume all panes without exposing an attach target", () => {
  const base = data().panes[0];
  const rows = dev01Rows(
    data({
      claude: [],
      panes: [base, { ...base, id: "%1", sessionId: "$1" }],
      pi: [
        { record: presence(), pane: "%0" },
        {
          record: presence({
            instance: "other",
            heartbeat: 99_001,
            tmux: { socket: base.socket, pane: "%1" },
          }),
          pane: "%1",
        },
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nativeCommand, undefined);
  assert.equal(rows[0].remoteTmux, undefined);
  assert.match(rows[0].detail, /Multiple tracked owners/);
});

test("headless remote Pi children retain native status alongside their interactive parent", () => {
  const parent = { record: presence(), pane: "%0" };
  const child = {
    record: presence({
      instance: "child",
      sessionId: "child-id",
      sessionFile: "/remote/child.jsonl",
      tmux: undefined,
      status: "working",
    }),
    pane: "%0",
  };
  for (const pi of [
    [parent, child],
    [child, parent],
  ]) {
    const rows = dev01Rows(data({ claude: [], pi }));
    assert.equal(rows.length, 2);
    const parentRow = rows.find((row) => row.key.endsWith("/session.jsonl"));
    const childRow = rows.find((row) => row.key.endsWith("/child.jsonl"));
    assert.deepEqual(parentRow.remoteTmux, remoteTarget);
    assert.equal(parentRow.nativeCommand, attachCommand(remoteTarget));
    assert.equal(parentRow.status, "ready");
    assert.equal(childRow.status, "working");
    assert.equal(childRow.remoteTmux, undefined);
    assert.equal(childRow.nativeCommand, undefined);
  }
});

test("remote Pi without an exact valid tmux presence cannot consume an ancestor's fallback pane", () => {
  for (const tmux of [
    undefined,
    null,
    {},
    { socket: "relative/socket", pane: "%0" },
    { socket: "/remote/other-socket", pane: "%0" },
    { socket: remoteTarget.socket, pane: "%1" },
    { socket: remoteTarget.socket, pane: "%0\n" },
    { socket: remoteTarget.socket, pane: "named-pane" },
  ]) {
    const rows = dev01Rows(
      data({
        claude: [],
        pi: [{ record: presence({ tmux }), pane: "%0" }],
      }),
    );
    assert.equal(rows.length, 2);
    const native = rows.find((row) => row.key.startsWith("dev01:pi:"));
    const fallback = rows.find((row) => row.key === "dev01:tmux:%0");
    assert.equal(native.status, "ready");
    assert.equal(native.remoteTmux, undefined);
    assert.equal(native.nativeCommand, undefined);
    assert.doesNotMatch(native.detail, /Attach to tmux/);
    assert.equal(fallback.status, "unknown");
    assert.deepEqual(fallback.remoteTmux, remoteTarget);
    assert.equal(fallback.nativeCommand, attachCommand(remoteTarget));
  }
});

for (const [label, records] of [
  ["healthy", [presence()]],
  ["stale", [presence({ heartbeat: 1 })]],
  ["duplicate", [presence(), presence({ instance: "other" })]],
  [
    "competing sessions",
    [
      presence(),
      presence({
        instance: "other",
        sessionId: "other-session",
        sessionFile: "/remote/other.jsonl",
      }),
    ],
  ],
]) {
  test(`nested Claude cannot bypass ${label} tracked remote Pi ownership`, () => {
    for (const pi of [records, [...records].reverse()]) {
      const claude = ["interactive", "background"].map((kind) => ({
        record: { ...data().claude[0].record, sessionId: kind, kind },
        pane: "%0",
      }));
      const rows = dev01Rows(
        data({
          claude,
          pi: pi.map((record) => ({ record, pane: "%0" })),
        }),
      );
      assert.equal(
        rows.length,
        2 + new Set(pi.map((record) => record.sessionFile)).size,
      );
      for (const row of rows.filter((row) => row.source === "claude")) {
        assert.equal(row.status, "working");
        assert.equal(row.remoteTmux, undefined);
        assert.equal(
          row.nativeCommand,
          undefined,
          "background attach is also blocked",
        );
        assert.match(row.detail, /tracked Pi/);
      }
      for (const row of rows.filter((row) => row.source === "pi")) {
        assert.equal(row.status, label === "healthy" ? "ready" : "unknown");
        assert.deepEqual(
          row.remoteTmux,
          label === "healthy" ? remoteTarget : undefined,
        );
        assert.equal(
          row.nativeCommand,
          label === "healthy" ? attachCommand(remoteTarget) : undefined,
        );
      }
    }
  });
}

test("duplicate remote Pi owners block nested Claude in every claimed pane", () => {
  const base = data().panes[0];
  const panes = [base, { ...base, id: "%1", sessionId: "$1" }];
  const rows = dev01Rows(
    data({
      panes,
      pi: panes.map((pane) => ({
        record: presence({
          instance: pane.id,
          tmux: { socket: pane.socket, pane: pane.id },
        }),
        pane: pane.id,
      })),
      claude: panes.map((pane) => ({
        record: {
          ...data().claude[0].record,
          sessionId: `nested-${pane.id.slice(1)}`,
          kind: "background",
        },
        pane: pane.id,
      })),
    }),
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => !row.remoteTmux && !row.nativeCommand));
});

test("exact Pi ownership protects its pane when process ancestry cannot confirm attachment", () => {
  for (const pane of [null, "%1"]) {
    const rows = dev01Rows(data({ pi: [{ record: presence(), pane }] }));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => !row.remoteTmux && !row.nativeCommand));
    assert.equal(rows.find((row) => row.source === "pi").status, "ready");
  }
});

test("remote socket paths retain their identity without local realpath or existence checks", (t) => {
  const directory = temporary(t);
  const socket = join(directory, "alias");
  symlinkSync(directory, socket);
  const base = data().panes[0];
  for (const path of [socket, "/does-not-exist-on-this-mac/socket"]) {
    const [row] = dev01Rows(data({ panes: [{ ...base, socket: path }] }));
    assert.equal(row.remoteTmux.socket, path);
  }
});

for (const socket of [
  undefined,
  null,
  123,
  "",
  "relative/socket",
  "/bad\npath",
  "/bad\u202epath",
  `/${"x".repeat(4096)}`,
]) {
  test(`remote discovery with unsafe socket ${JSON.stringify(socket)?.slice(0, 40)} never offers attach`, () => {
    const base = data().panes[0];
    for (const records of [
      {},
      { claude: [], pi: [{ record: presence(), pane: "%0" }] },
      { claude: [] },
    ]) {
      const rows = dev01Rows(
        data({ ...records, panes: [{ ...base, socket }] }),
      );
      for (const row of rows) {
        assert.equal(row.remoteTmux, undefined);
        assert.equal(row.nativeCommand, undefined);
      }
    }
    assert.throws(
      () => attachCommand({ ...remoteTarget, socket }),
      /Invalid remote tmux target/,
    );
  });
}

test("unbound or unsafe remote destinations never inherit current configuration", () => {
  for (const sshHost of [
    undefined,
    null,
    123,
    "",
    "-oProxyCommand=evil",
    "box other",
    "box\n",
  ]) {
    assert.throws(() => dev01Rows(data({ sshHost })), /SSH destination/);
    assert.throws(
      () => attachCommand({ ...remoteTarget, sshHost }),
      /Invalid remote tmux target/,
    );
    assert.throws(
      () => remoteTmuxAttachArgs({ ...remoteTarget, sshHost }),
      /Invalid remote tmux target/,
    );
  }
});

test("background command rendering uses the snapshot destination, never the current host", (t) => {
  writeFileSync(
    process.env.PI_EXTENSIONS_CONFIG,
    JSON.stringify({ remote: { host: "other-box" } }),
  );
  const input = data({ panes: [], claudeConfigDir: "/remote/O'Brien" });
  input.claude[0].record.kind = "background";
  const [row] = dev01Rows(input);
  assert.match(row.nativeCommand, /^ssh -t build-box /);
  assert.match(row.nativeCommand, /claude attach/);
});

test("remote discovery rejects pane and session IDs that are not exact numeric identities", () => {
  const base = data().panes[0];
  for (const invalid of [
    { id: "%0\n" },
    { sessionId: "$0\n" },
    { id: "named-pane" },
    { sessionId: "named-session" },
  ]) {
    assert.throws(
      () => dev01Rows(data({ panes: [{ ...base, ...invalid }] })),
      /Unsupported dev01 pane/,
    );
  }
});

test("untracked Pi explains the missing status record without claiming the extension is absent", () => {
  const base = data().panes[0];
  const [row] = dev01Rows(
    data({ claude: [], panes: [{ ...base, command: "pi" }] }),
  );
  assert.equal(row.source, "pi");
  assert.equal(row.status, "unknown");
  assert.deepEqual(row.remoteTmux, remoteTarget);
  assert.match(
    row.detail,
    /No Pi status record\. Install the Agents extension and run \/reload in this Pi session\./,
  );
  assert.doesNotMatch(
    row.detail,
    /extension (?:is )?(?:missing|not installed)/i,
  );
});

test("untracked panes stay Unknown, and remote background commands preserve config and quotes", () => {
  const [pane] = dev01Rows(data({ claude: [] }));
  assert.equal(pane.status, "unknown");
  assert.equal(pane.updated, 0);
  assert.deepEqual(pane.remoteTmux, remoteTarget);
  const input = data({ panes: [], claudeConfigDir: "/remote/O'Brien" });
  input.claude[0].record.kind = "background";
  const [row] = dev01Rows(input);
  assert.match(row.nativeCommand, /^ssh -t build-box /);
  assert.match(row.nativeCommand, /CLAUDE_CONFIG_DIR/);
  assert.match(row.nativeCommand, /claude attach/);
  assert.throws(() => dev01Rows({}), /Unsupported/);
  assert.throws(
    () => dev01Rows(data({ panes: [{ id: "$(evil)" }] })),
    /Unsupported/,
  );
  assert.equal(
    cleanOutput("hi\x1b]52;c;evil\x07\x1b[31m\nthere\u202e"),
    "hi\nthere",
  );
});

test("remote outage retains Unknown rows without hiding local sources; empty recovery clears them", async (t) => {
  let fail = false;
  let empty = false;
  const sessions = new ExternalSessions(
    [
      {
        source: "dev01",
        list: async () => {
          if (fail) throw Error("offline");
          return empty ? [] : dev01Rows(data());
        },
      },
      {
        source: "claude",
        list: async () => [{ key: "local", source: "claude", status: "ready" }],
      },
    ],
    () => {},
  );
  t.after(() => sessions.dispose());
  sessions.start();
  await tick();
  assert.deepEqual(sessions.rows[0].remoteTmux, remoteTarget);
  fail = true;
  sessions.refresh();
  await tick();
  assert.equal(sessions.rows[0].status, "unknown");
  assert.equal(sessions.rows[0].nativeCommand, undefined);
  assert.equal(sessions.rows[0].remoteTmux, undefined);
  assert.equal(sessions.rows[1].status, "ready");
  assert.match(sessions.summary, /dev01 unavailable/);
  fail = false;
  empty = true;
  sessions.refresh();
  await tick();
  assert.equal(sessions.rows.length, 1);
});

test("the executable works through its installed symlink", (t) => {
  const home = fake(t);
  const link = join(home, "bin/dev01");
  symlinkSync(join(root, "bin/dev01.mjs"), link);
  const output = execFileSync(link, ["ls"], { encoding: "utf8" });
  assert.match(output, /job · claude/);
  assert.match(output, /ssh -t build-box/);
});

test("package helpers locate the shipped probe independently of cwd", (t) => {
  env(t, "HOME", temporary(t));
  assert.equal(
    packagePath("bin", "dev01-status.py"),
    join(root, "bin/dev01-status.py"),
  );
  assert.match(
    readFileSync(packagePath("bin", "dev01-status.py"), "utf8"),
    /def collect\(\)/,
  );
  assert.equal(expandPath("~/handoff"), join(process.env.HOME, "handoff"));
  assert.deepEqual(readConfig().remote, {
    host: "build-box",
    project: "~/work/project",
    sharedDirectory: "shared-dev",
  });
});

async function harness(t) {
  const home = fake(t);
  const link = join(home, "dev01-extension");
  symlinkSync(root, link);
  const loaded = await loadExtensions(
    [join(link, "extensions/dev01/index.ts")],
    home,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(
    existsSync(join(home, "ssh-args")),
    false,
    "loading performs no I/O",
  );
  const extension = loaded.extensions[0];
  const messages = [],
    notices = [],
    statuses = new Map();
  loaded.runtime.sendMessage = (message, options) =>
    messages.push({ message, options });
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message) => notices.push(message),
      setStatus: (key, value) => statuses.set(key, value),
    },
  };
  return {
    home,
    extension,
    messages,
    notices,
    statuses,
    ctx,
    command: (name, args = "") =>
      extension.commands.get(name).handler(args, ctx),
    shutdown: async () => {
      for (const fn of extension.handlers.get("session_shutdown") || [])
        await fn({}, ctx);
    },
  };
}

test("real Pi loader registers five commands; output does not trigger a model turn", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.extension.commands.keys()].sort(), [
    "devclip",
    "devls",
    "devpull",
    "devpush",
    "devrun",
  ]);
  await h.command("devls");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options.triggerTurn, false);
  assert.match(h.messages[0].message.content, /ssh -t build-box/);
  assert.equal(h.statuses.get("dev01"), undefined);
  await h.command("devpush", "--delete");
  await h.command("devrun", "../invalid task");
  assert.equal(h.notices.length, 2);
  assert.equal(h.messages.length, 1);
  const rows = await createDev01Adapter().list(AbortSignal.timeout(2000));
  assert.equal(rows[0].host, "dev01");
});

test("shutdown cancels a pending local helper without reporting success or launching more work", async (t) => {
  const h = await harness(t);
  env(t, "DEV01_FIXTURE_HANG", "1");
  const operation = h.command("devls");
  await tick();
  await h.command("devpush");
  assert.match(h.notices[0], /already running/);
  await h.shutdown();
  await operation;
  assert.equal(h.messages.length, 0);
});
