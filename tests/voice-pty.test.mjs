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
  test(
    `real Pi ${mode} voice gestures preserve Vim and redraw Space without microphone access`,
    {
      skip:
        process.platform === "win32" ||
        spawnSync("python3", ["--version"]).status !== 0,
      timeout: 25000,
    },
    (t) => {
      const home = mkdtempSync(join(tmpdir(), "pi-voice-pty-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      mkdirSync(join(home, "agent"));
      const extension = join(home, "fixture.ts");
      writeFileSync(
        extension,
        `
import vim from ${JSON.stringify(join(root, "extensions/vim/index.ts"))};
import { installVoice } from ${JSON.stringify(join(root, "extensions/voice/index.ts"))};
export default function (pi) {
  vim(pi);
  installVoice(pi, {
    supported: () => true,
    createWorker({ onEvent }) {
      queueMicrotask(() => onEvent({type: 'ready'}));
      return {
        send(event) {
          if (event.type === 'start') {
            onEvent({type: 'recording', id: event.id});
            onEvent({type: 'partial', id: event.id, text: 'synthetic preview'});
          } else if (event.type === 'stop') {
            onEvent({type: 'final', id: event.id, text: 'literal dw'});
          }
          return true;
        },
        async close() {},
      };
    },
  });
  pi.registerShortcut('ctrl+alt+p', {
    description: 'Synthetic test probe',
    handler: async (ctx) => {
      ctx.ui.setWidget('probe', (tui) => {
        const editor = tui.getFocusedComponent();
        ctx.ui.notify('PROBE ' + JSON.stringify({text: editor.getText(), insert: editor.acceptsLiteralSpace}));
        return {render: () => [], invalidate() {}};
      });
    },
  });
}
`,
      );
      const script = String.raw`import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct, re
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
os.close(slave)
data = b''
def drain(seconds=.15):
    global data
    end = time.time() + seconds
    while time.time() < end:
        if select.select([master], [], [], .02)[0]: data += os.read(master, 65536)
def wait_for(marker):
    end = time.time() + 6
    while marker not in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', data):
        if time.time() > end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-2500:]))
        drain(.05)
def send(text):
    global data
    data = b''
    os.write(master, text)
try:
    wait_for(b'INSERT')
    send(b'\x1b[?7u\x1b[?1;2c/voice on\r')
    wait_for(b'voice')
    wait_for(b'ready')
    send(b'\x1b[32;5u')
    wait_for(b'recording')
    wait_for(b'synthetic preview')
    send(b'\x1b')
    wait_for(b'NORMAL')
    send(b'\x1b[32;5:3u')
    wait_for(b'literal dw')
    send(b'\x1b[112;7u')
    wait_for(b'PROBE {"text":"literal dw","insert":false}')
    send(b'u')
    drain()
    send(b'\x1b[112;7u')
    wait_for(b'PROBE {"text":"","insert":false}')
    send(b'i/voice space on\r')
    wait_for(b'Hold-Space enabled')
    send(b'\x1b[32;1u\x1b[32;1:3u')
    drain(.25)
    if not data: raise RuntimeError('Space tap did not redraw the real TUI')
    send(b'\x1b[112;7u')
    wait_for(b'PROBE {"text":" ","insert":true}')
    send(b'\x03/voice off\r')
    drain()
    send(b'/reload\r')
    wait_for(b'Reloaded keybindings, extensions')
    wait_for(b'INSERT')
    send(b'\x04')
    end = time.time() + 3
    while p.poll() is None and time.time() < end:
        try: drain(.05)
        except OSError: break
    p.wait(timeout=3)
    print(json.dumps({'exit': p.returncode}))
finally:
    if p.poll() is None: p.kill()
    os.close(master)
    p.wait(timeout=3)
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
          timeout: 22000,
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, "agent"),
            TERM: "xterm-256color",
            TMUX: "",
            TMUX_PANE: "",
          },
        },
      );
      assert.deepEqual(JSON.parse(result), { exit: 0 });
    },
  );
}
