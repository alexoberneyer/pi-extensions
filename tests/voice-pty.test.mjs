import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(packageDir, "Run with node scripts/test.mjs.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const mode of ["regular", "fullscreen"]) {
  for (const editor of ["vim", "stock"]) {
    test(
      `real Pi ${mode} ${editor} voice gestures and persistent standby without microphone access`,
      {
        skip:
          process.platform === "win32" ||
          spawnSync("python3", ["--version"]).status !== 0,
        timeout: 50000,
      },
      (t) => {
        const home = mkdtempSync(join(tmpdir(), "pi-voice-pty-"));
        t.after(() => rmSync(home, { recursive: true, force: true }));
        mkdirSync(join(home, "agent"));
        const profile = join(home, "profile");
        mkdirSync(profile);
        const configFile = join(profile, "config.json");
        writeFileSync(
          configFile,
          JSON.stringify({ voice: { cancelShortcut: "ctrl+alt+x" } }),
        );
        const workerLog = join(home, "worker-events.jsonl");
        const extension = join(home, "fixture.ts");
        writeFileSync(
          extension,
          `
import { appendFileSync } from 'node:fs';
import vim from ${JSON.stringify(join(root, "extensions/vim/index.ts"))};
import { installVoice } from ${JSON.stringify(join(root, "extensions/voice/index.ts"))};
const log = (event) => appendFileSync(${JSON.stringify(workerLog)}, JSON.stringify(event) + '\\n');
export default function (pi) {
  let probes = 0;
  ${editor === "vim" ? "vim(pi);" : ""}
  installVoice(pi, {
    supported: () => true,
    idleMs: 1000,
    createWorker({ onEvent }) {
      log({type: 'worker'});
      const ready = setTimeout(() => onEvent({type: 'ready'}), 200);
      return {
        send(event) {
          log(event);
          if (event.type === 'start') {
            onEvent({type: 'recording', id: event.id});
            onEvent({type: 'partial', id: event.id, text: 'synthetic preview'});
          } else if (event.type === 'stop') {
            onEvent({type: 'final', id: event.id, text: 'literal dw'});
          } else if (event.type === 'cancel') {
            queueMicrotask(() => onEvent({type: 'final', id: event.id, text: 'retired synthetic final'}));
          }
          return true;
        },
        async close() {
          clearTimeout(ready);
          log({type: 'close'});
        },
      };
    },
  });
  pi.on('session_start', (_event, ctx) => ctx.ui.notify('VOICE FIXTURE READY'));
  pi.registerShortcut('ctrl+alt+p', {
    description: 'Synthetic test probe',
    handler: async (ctx) => {
      ctx.ui.setWidget('probe', (tui) => {
        const editor = tui.getFocusedComponent();
        // Make every result distinct so differential rendering emits repeated drafts.
        ctx.ui.notify('PROBE ' + JSON.stringify({text: editor.getText(), insert: editor.acceptsLiteralSpace ?? true}) + ' #' + ++probes);
        return {render: () => [], invalidate() {}};
      });
    },
  });
}
`,
        );
        const script = String.raw`import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct, re
argv = sys.argv[1:]
vim = os.environ['VOICE_TEST_EDITOR'] == 'vim'
log_file = os.environ['VOICE_TEST_LOG']
pref_file = os.path.join(os.path.dirname(os.environ['PI_EXTENSIONS_CONFIG']), 'voice-state.json')
p = None
master = None
data = b''
ansi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
def plain():
    return ansi.sub(b'', data)
def drain(seconds=.1):
    global data
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([master], [], [], .02)[0]:
            chunk = os.read(master, 65536)
            if not chunk: break
            data += chunk
            if re.search(rb'discard|ctrl\+alt\+x', plain(), re.I):
                raise RuntimeError('removed cancellation hint appeared')
def wait_for(marker, timeout=6):
    end = time.monotonic() + timeout
    while marker not in plain():
        if time.monotonic() > end:
            raise RuntimeError('missing '+repr(marker)+' in '+repr(plain()[-2500:]))
        drain(.03)
def send(text):
    global data
    data = b''
    os.write(master, text)
def probe(text, insert=True):
    send(b'\x1b[112;7u')
    marker = 'PROBE ' + json.dumps({'text': text, 'insert': insert}, separators=(',', ':'))
    wait_for(marker.encode())
def entries():
    if not os.path.exists(log_file): return []
    with open(log_file) as f: return [json.loads(line) for line in f]
def count(kind):
    return sum(event['type'] == kind for event in entries())
def saved():
    with open(pref_file) as f: return json.load(f) == {'version': 1, 'enabled': True}
def launch():
    global p, master, data
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
    def child_setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    try:
        p = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
    finally:
        os.close(slave)
    data = b''
    wait_for(b'VOICE FIXTURE READY')
    if vim: wait_for(b'INSERT')
    os.write(master, b'\x1b[?7u\x1b[?1;2c')
def finish():
    global master
    end = time.monotonic() + 4
    while p.poll() is None and time.monotonic() < end:
        try: drain(.03)
        except OSError: break
    p.wait(timeout=3)
    if p.returncode != 0: raise RuntimeError('Pi exit '+str(p.returncode))
    os.close(master)
    master = None
try:
    launch()
    probe('')
    assert count('worker') == 0, 'startup created a worker'
    assert not os.path.exists(pref_file), 'startup wrote a preference'

    # A keyboard activation from off persists on and only warms the model.
    send(b'\x1b[32;5u')
    wait_for(b'ready')
    assert count('worker') == 1 and count('start') == 0, entries()
    assert saved()
    send(b'\x1b[32;5u')
    wait_for(b'recording')
    wait_for(b'synthetic preview')
    send(b'\x1b')
    if vim: wait_for(b'NORMAL')
    else: drain()
    assert count('cancel') == 0 and count('stop') == 0, 'Escape cancelled speech'
    send(b'\x1b[32;5:3u')
    wait_for(b'literal dw')
    probe('literal dw', not vim)
    send(b'u' if vim else b'\x1f')
    drain()
    probe('', not vim)
    if vim:
        send(b'i')
        drain()

    # Legacy NUL is a toggle, even after Kitty negotiation succeeded.
    send(b'\x00')
    wait_for(b'recording')
    send(b'\x00')
    wait_for(b'literal dw')
    probe('literal dw')
    send(b'\x1f')
    drain()
    probe('')

    send(b'\x1b[200~fixture draft\x1b[201~\x00')
    wait_for(b'recording')
    send(b'\x03')
    drain()
    probe('')
    assert count('cancel') == 1, 'Ctrl+C did not cancel fake capture'
    assert count('start') == 3, entries()

    send(b'/voice space on\r')
    wait_for(b'Hold-Space enabled')
    send(b'\x1b[32;1u\x1b[32;1:3u')
    drain(.25)
    if not data: raise RuntimeError('Space tap did not redraw the real TUI')
    probe(' ')
    send(b'\x7f/voice off\r')
    drain()
    with open(pref_file) as f:
        assert json.load(f) == {'version': 1, 'enabled': False}
    send(b'/voice on\r')
    wait_for(b'ready')
    workers = count('worker')
    starts = count('start')
    send(b'/reload\r')
    wait_for(b'Reloaded keybindings, extensions')
    wait_for(b'standby')
    assert count('worker') == workers, 'reload warmed the worker'
    assert count('start') == starts and saved()
    probe('')

    # The restored main editor binds after the real reload panel loses focus.
    send(b'\x1b[32;5u')
    wait_for(b'wait before speaking')
    wait_for(b'recording')
    assert count('worker') == workers + 1 and count('start') == starts + 1
    send(b'\x1b[32;5:3u')
    wait_for(b'literal dw')
    probe('literal dw')
    send(b'\x1f')
    drain()
    probe('')
    wait_for(b'standby', timeout=2)
    assert saved(), 'idle unload disabled Voice persistently'

    # Releasing a cold hold before fake readiness must not start capture.
    workers = count('worker')
    starts = count('start')
    send(b'\x1b[32;5u\x1b[32;5:3u')
    wait_for(b'ready')
    assert count('worker') == workers + 1 and count('start') == starts
    wait_for(b'standby', timeout=2)
    workers = count('worker')
    send(b'\x04')
    finish()
    assert saved(), 'session shutdown persisted off'

    launch()
    wait_for(b'standby')
    probe('')
    assert count('worker') == workers, 'fresh process loaded a model at startup'
    assert count('start') == starts and saved()
    send(b'\x1b[32;5u')
    wait_for(b'recording')
    assert count('worker') == workers + 1 and count('start') == starts + 1
    # Both presses must reach Pi: clear/cancel first, native double-Ctrl+C exit second.
    send(b'\x03\x03')
    finish()
    assert count('cancel') == 2, entries()
    assert saved()
    with open(os.environ['PI_EXTENSIONS_CONFIG']) as f:
        assert json.load(f) == {'voice': {'cancelShortcut': 'ctrl+alt+x'}}
    print(json.dumps({'exits': [0, 0], 'restored': True}))
finally:
    if p is not None:
        if p.poll() is None: p.kill()
        p.wait(timeout=3)
    if master is not None: os.close(master)
`;
        const result = execFileSync(
          "python3",
          [
            "-c",
            script,
            process.execPath,
            join(packageDir, "dist/cli.js"),
            "--offline",
            "--no-session",
            "--no-extensions",
            "--extension",
            extension,
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
            timeout: 45000,
            env: {
              ...process.env,
              HOME: home,
              XDG_CONFIG_HOME: join(home, ".config"),
              XDG_CACHE_HOME: join(home, ".cache"),
              PI_CODING_AGENT_DIR: join(home, "agent"),
              PI_EXTENSIONS_CONFIG: configFile,
              VOICE_TEST_EDITOR: editor,
              VOICE_TEST_LOG: workerLog,
              TERM: "xterm-256color",
              TMUX: "",
              TMUX_PANE: "",
            },
          },
        );
        assert.deepEqual(JSON.parse(result), { exits: [0, 0], restored: true });
      },
    );
  }
}
