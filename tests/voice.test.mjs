import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { VoiceKeys } from "../extensions/voice/keys.mjs";
import { readConfig } from "../lib/config.mjs";

const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(packageDir, "Run with node scripts/test.mjs.");
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/jiti-loader.js"))
);
// Match the installed extension loader's aliases, sharing the real host classes.
const alias = {
  "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { installVoice } = await jiti.import(
  join(root, "extensions/voice/index.ts"),
);
const { VimEditor } = await jiti.import(join(root, "extensions/vim/index.ts"));
const { CustomEditor } = await jiti.import(
  alias["@earendil-works/pi-coding-agent"],
);
const { KeybindingsManager } = await jiti.import(
  join(packageDir, "dist/core/keybindings.js"),
);
const {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  setKeybindings,
  setKittyProtocolActive,
} = await jiti.import(alias["@earendil-works/pi-tui"]);

const config = {
  shortcut: "ctrl+space",
  mode: "hold",
  space: false,
  device: ":default",
};
const esc = "\x1b";
const paste = (text) => `\x1b[200~${text}\x1b[201~`;
const kitty = (key, modifiers = 1, event = 1) =>
  `\x1b[${typeof key === "string" ? key.codePointAt(0) : key};${modifiers}:${event}u`;
const press = kitty(" ", 5);
const repeat = kitty(" ", 5, 2);
const release = kitty(" ", 5, 3);
const cancel = "\x03";
const oldCancel = kitty("x", 7);
const spacePress = kitty(" ");
const spaceRelease = kitty(" ", 1, 3);
const tick = () => new Promise((done) => setImmediate(done));
const identity = (text) => text;
const theme = {
  fg: (_color, text) => text,
  borderColor: identity,
  selectList: Object.fromEntries(
    [
      "selectedPrefix",
      "selectedText",
      "description",
      "scrollInfo",
      "noMatch",
    ].map((key) => [key, identity]),
  ),
};

// Enable the clock before any worker can schedule its five-minute idle timer.
// Replacing timers after activation would leave the earlier real timer alive.
test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(performance, "now", () => Date.now());
});

function parsed(data) {
  return {
    key: parseKey(data),
    release: isKeyRelease(data),
    repeat: isKeyRepeat(data),
    encoded: data.startsWith("\x1b["),
  };
}

function assertMode(editor, expected) {
  assert.match(editor.render(80).at(-1), new RegExp(` ${expected} $`));
}

function normalAtStart(editor, text) {
  editor.setText(text);
  editor.handleInput(esc);
  editor.handleInput("0");
  assertMode(editor, "NORMAL");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
}

function harness(t, options = {}) {
  const directory =
    options.directory ?? mkdtempSync(join(tmpdir(), "pi-voice-test-"));
  if (!options.directory)
    t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = join(directory, "config.json");
  const preferenceFile = join(directory, "voice-state.json");
  if (!existsSync(configFile) || options.voice)
    writeFileSync(
      configFile,
      JSON.stringify(options.voice ? { voice: options.voice } : {}),
    );
  if (Object.hasOwn(options, "saved"))
    writeFileSync(
      preferenceFile,
      JSON.stringify({ version: 1, enabled: options.saved }),
    );
  const commands = new Map();
  const shortcuts = new Map();
  const events = new Map();
  const listeners = new Set();
  const workers = [];
  const notices = [];
  const pastes = [];
  const submissions = [];
  const writes = [];
  const widgetCalls = [];
  const dispatched = [];
  const pending = [];
  let widget;
  let focused;
  let interrupts = 0;
  const tui = {
    terminal: {
      kittyProtocolActive: options.protocol ?? true,
      rows: 30,
      columns: 80,
      write: (data) => writes.push(data),
    },
    getFocusedComponent: () => focused,
    requestRender: t.mock.fn(),
    inputListeners: listeners,
    addInputListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const bindings = new KeybindingsManager(options.bindings ?? {});
  setKeybindings(bindings);
  setKittyProtocolActive(tui.terminal.kittyProtocolActive);
  t.after(() => setKittyProtocolActive(false));
  const Editor = options.editor === "stock" ? CustomEditor : VimEditor;
  const editor = new Editor(tui, theme, bindings);
  assert.ok(editor instanceof CustomEditor);
  if (Editor === VimEditor) {
    assert.equal(editor.supported, true);
    tui.addInputListener(editor.inputListener);
  }
  focused = editor;
  editor.focused = true;
  const baselineListeners = listeners.size;
  const pi = {
    exec: t.mock.fn(options.exec ?? (async () => ({ code: 1 }))),
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerShortcut: (key, definition) => shortcuts.set(key, definition),
    sendUserMessage: t.mock.fn(() =>
      assert.fail("Voice must not submit a prompt"),
    ),
  };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") === "tui",
    abort: t.mock.fn(() => assert.fail("Voice must not abort Pi")),
    ui: {
      getEditorComponent: () =>
        Editor === VimEditor ? () => editor : undefined,
      getEditorText: () => editor.getExpandedText(),
      setEditorText: () => assert.fail("Voice must not replace the draft"),
      pasteToEditor(text) {
        pastes.push(text);
        editor.handleInput(paste(text));
      },
      notify: (message, level) => notices.push({ message, level }),
      onTerminalInput: (listener) => tui.addInputListener(listener),
      setWidget(name, content) {
        assert.equal(name, "local-voice");
        widgetCalls.push(content);
        // Pi invokes factories synchronously. Every factory sees the same TUI.
        widget = typeof content === "function" ? content(tui, theme) : content;
      },
    },
  };
  async function emit(name, event = {}) {
    for (const handler of events.get(name) ?? [])
      await handler({ type: name, ...event }, ctx);
  }
  editor.onEscape = () => interrupts++;
  const nativeClear = t.mock.fn(() => editor.setText(""));
  editor.onAction("app.clear", nativeClear);
  editor.onSubmit = (text) => {
    submissions.push(text);
    // Pi dispatches commands before its input event, including built-ins.
    if (text.startsWith("/")) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      const command = commands.get(name);
      if (command)
        pending.push(Promise.resolve(command.handler(args.join(" "), ctx)));
      return;
    }
    pending.push(emit("input", { source: "interactive", text }));
  };
  // Pi uses this callback to distinguish the main prompt from dialog editors.
  editor.onExtensionShortcut = (data) => {
    for (const [key, definition] of shortcuts) {
      if (!matchesKey(data, key)) continue;
      pending.push(Promise.resolve(definition.handler(ctx)));
      return true;
    }
    return false;
  };
  if (options.dialog) {
    focused = new CustomEditor(tui, theme, bindings);
    editor.focused = false;
  }
  const oldConfig = process.env.PI_EXTENSIONS_CONFIG;
  let controller;
  try {
    process.env.PI_EXTENSIONS_CONFIG = configFile;
    controller = installVoice(pi, {
      preferences: options.preferences,
      idleMs: options.idleMs,
      safety: options.safety ?? { teardownFailed: false },
      supported: () => options.supported ?? true,
      createWorker(callbacks) {
        const worker = {
          callbacks,
          commands: [],
          closed: 0,
          emit: (event) => callbacks.onEvent(event),
          send(event) {
            this.commands.push(event);
            if (event.type === "start" && options.autoRecording !== false)
              queueMicrotask(() =>
                this.emit({ type: "recording", id: event.id }),
              );
            return true;
          },
          async close() {
            this.closed++;
          },
        };
        workers.push(worker);
        if (options.autoReady !== false)
          queueMicrotask(() => worker.emit({ type: "ready" }));
        return worker;
      },
    });
  } finally {
    if (oldConfig === undefined) delete process.env.PI_EXTENSIONS_CONFIG;
    else process.env.PI_EXTENSIONS_CONFIG = oldConfig;
  }
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    assert.equal(pi.sendUserMessage.mock.callCount(), 0);
    assert.equal(ctx.abort.mock.callCount(), 0);
  });
  const h = {
    directory,
    configFile,
    preferenceFile,
    nativeClear,
    controller,
    editor,
    ctx,
    tui,
    pi,
    commands,
    shortcuts,
    events,
    listeners,
    workers,
    notices,
    pastes,
    submissions,
    writes,
    widgetCalls,
    dispatched,
    baselineListeners,
    get worker() {
      return workers.at(-1);
    },
    get widget() {
      return widget;
    },
    get interrupts() {
      return interrupts;
    },
    focus(component = editor) {
      editor.focused = component === editor;
      focused = component;
    },
    dialog() {
      return new CustomEditor(tui, theme, bindings);
    },
    emit,
    renderWidget() {
      const text = widget?.render(80).join("\n") ?? "";
      assert.doesNotMatch(text, /discard|ctrl\+alt\+x/i);
      return text;
    },
    saved: () => JSON.parse(readFileSync(preferenceFile, "utf8")).enabled,
    command: (args) => commands.get("voice").handler(args, ctx),
    async input(data) {
      for (const listener of listeners) {
        const result = listener(data);
        if (result?.consume) return result;
      }
      // Match the real TUI: releases reach listeners, not ordinary editors.
      if (!isKeyRelease(data)) {
        dispatched.push(data);
        focused?.handleInput(data);
      }
      await Promise.all(pending.splice(0));
    },
    async type(text) {
      for (const key of text) await this.input(key);
    },
    async enable() {
      await this.command("on");
      assert.equal(controller.state, "ready");
      assert.deepEqual(this.worker.commands, []);
    },
    async record() {
      await this.input(press);
      // Consumed listener input returns before the asynchronous recording ack.
      await Promise.resolve();
      assert.equal(controller.state, "recording");
      return this.worker.commands.at(-1).id;
    },
  };
  return h;
}

function keysHarness(t, options = {}) {
  const context = {
    enabled: true,
    atMain: true,
    releaseSupported: true,
    spaceEnabled: true,
    spaceAllowed: true,
    ready: true,
    pending: false,
    active: false,
    ...options.context,
  };
  const actions = [];
  const keys = new VoiceKeys({
    ...config,
    ...options,
    getContext: () => context,
    onStart() {
      actions.push("start");
      context.ready = false;
      context.active = true;
    },
    onStop() {
      actions.push("stop");
      context.active = false;
    },
    onTapSpace: () => actions.push("space"),
  });
  t.after(() => keys.reset());
  return { keys, context, actions, input: (data) => keys.handle(parsed(data)) };
}

test("defaults install and session startup allocate no voice resources", async (t) => {
  t.mock.method(globalThis, "setTimeout", () => assert.fail("startup timer"));
  const h = harness(t);
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.controller.state, "off");
  assert.equal(h.controller.enabled, false);
  assert.equal(h.workers.length, 0);
  assert.equal(h.listeners.size, h.baselineListeners);
  assert.deepEqual(h.widgetCalls, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual([...h.shortcuts.keys()], [config.shortcut]);
  assert.equal(existsSync(h.preferenceFile), false);
  assert.equal(h.pi.exec.mock.callCount(), 0);
  assert.deepEqual([...h.commands.keys()], ["voice"]);
  assert.equal(
    h.commands.get("voice").getArgumentCompletions("space ").length,
    2,
  );
});

test("status resolves the current system input every time without enabling Voice", async (t) => {
  let stdout = "Built-in Test Microphone\n";
  const h = harness(t, { exec: async () => ({ code: 0, stdout }) });
  await h.command("status");
  assert.equal(
    h.notices.at(-1).message,
    "Voice off. Next input: Built-in Test Microphone (system default).",
  );
  stdout = "USB \x1b[31mDesk\x1b[0m Mic\n";
  await h.command("status");
  assert.match(h.notices.at(-1).message, /Next input: USB Desk Mic/);
  assert.equal(h.pi.exec.mock.callCount(), 2);
  const [file, args] = h.pi.exec.mock.calls[0].arguments;
  assert.equal(file, "/usr/bin/osascript");
  assert.match(args.at(-1), /defaultDeviceWithMediaType/);
  assert.equal(h.workers.length, 0);
  assert.equal(existsSync(h.preferenceFile), false);
});

for (const [device, killed, name] of [
  [":02", false, "USB Desk Mic"],
  [":4", false, "unavailable"],
  [":2", true, "unavailable"],
]) {
  test(`status resolves numbered audio input ${device} (killed: ${killed})`, async (t) => {
    const h = harness(t, {
      saved: true,
      voice: { device },
      exec: async () => ({
        code: 1,
        killed,
        stderr: [
          "[AVFoundation indev @ 0x1] AVFoundation video devices:",
          "[AVFoundation indev @ 0x1] [2] Test Camera",
          "[AVFoundation indev @ 0x1] [4] Test Screen",
          "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
          "[AVFoundation indev @ 0x1] [0] Built-in Test Microphone",
          "[AVFoundation indev @ 0x1] [2] USB Desk Mic",
          "Error opening input files: Input/output error",
        ].join("\n"),
      }),
    });
    await h.emit("session_start");
    await h.command("status");
    assert.ok(
      h.notices
        .at(-1)
        .message.startsWith(`Voice standby. Next input: ${name} (${device}).`),
    );
    const [file, args] = h.pi.exec.mock.calls[0].arguments;
    assert.equal(file, "ffmpeg");
    assert.deepEqual(args.slice(-4), ["-list_devices", "true", "-i", ""]);
    assert.equal(h.workers.length, 0);
  });
}

for (const options of [{ supported: false }, { mode: "rpc" }]) {
  test(`status does not query inputs outside supported interactive Pi (${JSON.stringify(options)})`, async (t) => {
    const h = harness(t, options);
    await h.command("status");
    assert.match(h.notices.at(-1).message, /Next input: unavailable/);
    assert.equal(h.pi.exec.mock.callCount(), 0);
  });
}

for (const activation of ["command", "shortcut", "start"]) {
  test(`${activation} from off warms the worker without starting capture`, async (t) => {
    const h = harness(t);
    if (activation === "shortcut") await h.input(press);
    else await h.command(activation === "start" ? "start" : "on");
    assert.equal(h.controller.state, "ready");
    assert.equal(h.workers.length, 1);
    assert.equal(h.worker.callbacks.device, config.device);
    assert.deepEqual(h.worker.commands, []);
    assert.match(h.renderWidget(), /ready.*hold ctrl\+space/);
    assert.equal(h.saved(), true);
    assert.equal(readFileSync(h.configFile, "utf8"), "{}");
    assert.deepEqual(h.writes, [], "Space reporting is opt-in");
    await h.command("on");
    assert.equal(h.workers.length, 1);
    assert.equal(h.listeners.size, h.baselineListeners + 1);
  });
}

for (const editor of ["vim", "stock"]) {
  test(`${editor} saved enabled restores standby without model, microphone or timers`, async (t) => {
    const h = harness(t, { editor, saved: true });
    t.mock.method(globalThis, "setTimeout", () => assert.fail("restore timer"));
    await h.emit("session_start", { reason: "startup" });
    assert.equal(h.controller.state, "standby");
    assert.equal(h.controller.enabled, true);
    assert.equal(h.controller.recordingRequested, false);
    assert.equal(h.workers.length, 0);
    assert.equal(h.listeners.size, h.baselineListeners + 1);
    assert.match(h.renderWidget(), /standby/);
    assert.equal(h.saved(), true);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.notices, []);
    await h.emit("session_shutdown", { reason: "reload" });
    assert.equal(h.saved(), true, "shutdown must not persist off");
  });
}

test("new windows and factories read the latest preference without syncing existing windows", async (t) => {
  const first = harness(t);
  const second = harness(t, { directory: first.directory });
  await first.enable();
  await second.emit("session_start");
  assert.equal(second.controller.state, "standby");
  assert.equal(second.workers.length, 0);
  await first.emit("session_shutdown", { reason: "reload" });
  assert.equal(first.saved(), true);
  const third = harness(t, { directory: first.directory });
  await third.emit("session_start");
  assert.equal(third.controller.state, "standby");
  assert.equal(third.workers.length, 0);
  await second.command("off");
  assert.equal(second.saved(), false);
  assert.equal(third.controller.state, "standby", "no cross-window auto-sync");
  const fourth = harness(t, { directory: first.directory });
  await fourth.emit("session_start");
  assert.equal(fourth.controller.state, "off");
  assert.equal(fourth.workers.length, 0);
  assert.deepEqual(fourth.widgetCalls, []);
  assert.equal(readFileSync(first.configFile, "utf8"), "{}");
});

for (const failure of ["malformed JSON", "invalid schema", "read failure"]) {
  test(`saved preference ${failure} leaves Voice off with a safe notice`, async (t) => {
    const h = harness(t);
    if (failure === "read failure") mkdirSync(h.preferenceFile);
    else
      writeFileSync(
        h.preferenceFile,
        failure === "malformed JSON"
          ? "{synthetic private diagnostic"
          : '{"version":1,"enabled":"true"}',
      );
    await h.emit("session_start");
    assert.equal(h.controller.state, "off");
    assert.equal(h.workers.length, 0);
    assert.equal(h.listeners.size, h.baselineListeners);
    assert.deepEqual(h.widgetCalls, []);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].level, "error");
    assert.match(h.notices[0].message, /Cannot read saved Voice preference/);
    assert.doesNotMatch(
      h.notices[0].message,
      /private|diagnostic|voice-state\.json/,
    );
  });
}

for (const activation of ["on", "start", "shortcut"]) {
  test(`${activation} cannot load a model when persisting on fails`, async (t) => {
    const writes = [];
    const h = harness(t, {
      preferences: {
        read: () => false,
        write(value) {
          writes.push(value);
          throw new Error("synthetic private save diagnostic");
        },
      },
    });
    if (activation === "shortcut") await h.input(press);
    else await h.command(activation);
    assert.deepEqual(writes, [true]);
    assert.equal(h.controller.state, "off");
    assert.equal(h.workers.length, 0);
    assert.equal(h.listeners.size, h.baselineListeners);
    assert.equal(h.widget, undefined);
    assert.match(h.notices[0].message, /Cannot save Voice preference/);
    assert.doesNotMatch(h.notices[0].message, /private|diagnostic/);
  });
}

test("off still closes a recording worker if persisting off fails; shutdown never writes", async (t) => {
  const writes = [];
  const h = harness(t, {
    preferences: {
      read: () => false,
      write(value) {
        writes.push(value);
        if (!value) throw new Error("synthetic private save diagnostic");
      },
    },
  });
  await h.enable();
  const id = await h.record();
  await h.command("off");
  assert.deepEqual(writes, [true, false]);
  assert.equal(h.controller.state, "off");
  assert.equal(h.worker.closed, 1);
  assert.equal(h.listeners.size, h.baselineListeners);
  assert.equal(h.widget, undefined);
  assert.match(h.notices[0].message, /Voice is off here/);
  assert.doesNotMatch(h.notices[0].message, /private|diagnostic/);
  h.worker.emit({ type: "final", id, text: "late speech" });
  assert.deepEqual(h.pastes, []);
  await h.emit("session_shutdown");
  assert.deepEqual(writes, [true, false]);
});

for (const attachment of ["render", "input"]) {
  test(`stock reload restore defers main editor binding until ${attachment}`, async (t) => {
    const h = harness(t, { editor: "stock", dialog: true, saved: true });
    const original = h.editor.onSubmit;
    await h.emit("session_start", { reason: "reload" });
    assert.equal(h.controller.state, "standby");
    assert.equal(h.workers.length, 0);
    assert.match(h.renderWidget(), /standby/);
    assert.equal(h.editor.onSubmit, original);
    assert.deepEqual(h.notices, []);
    h.focus();
    if (attachment === "render") h.renderWidget();
    else await h.input("\x01"); // Refresh through native input without changing the draft.
    assert.notEqual(h.editor.onSubmit, original);
    await h.input(press);
    await tick();
    assert.equal(h.controller.state, "recording");
    const id = h.worker.commands.at(-1).id;
    await h.input(release);
    await h.type("/fixture-extension");
    await h.input("\r");
    h.worker.emit({ type: "final", id, text: "retired speech" });
    assert.equal(h.editor.getText(), "");
    assert.deepEqual(h.pastes, []);
    await h.command("off");
    assert.equal(h.saved(), false);
    assert.equal(h.editor.onSubmit, original);
  });
}

for (const initial of ["standby", "loading"]) {
  test(`hold from ${initial} queues consent and waits for recording before speaking`, async (t) => {
    const h = harness(t, {
      saved: true,
      autoReady: false,
      autoRecording: false,
    });
    await h.emit("session_start");
    if (initial === "loading") await h.command("on");
    await h.input(press);
    assert.equal(h.controller.state, "loading");
    assert.equal(h.controller.recordingRequested, true);
    assert.deepEqual(h.worker.commands, []);
    assert.match(h.renderWidget(), /loading.*wait before speaking/);
    h.worker.emit({ type: "ready" });
    assert.equal(h.controller.state, "starting");
    const id = h.worker.commands.at(-1).id;
    assert.deepEqual(h.worker.commands, [{ type: "start", id }]);
    assert.doesNotMatch(h.renderWidget(), /● recording/);
    await h.command("status");
    assert.match(
      h.notices.at(-1).message,
      /Wait for recording before speaking/,
    );
    h.worker.emit({ type: "recording", id });
    assert.equal(h.controller.state, "recording");
    assert.match(h.renderWidget(), /● recording/);
    await h.input(release);
    assert.equal(h.controller.state, "finalizing");
    h.worker.emit({ type: "final", id, text: "cold result" });
    assert.equal(h.ctx.ui.getEditorText(), "cold result");
    assert.equal(h.controller.recordingRequested, false);
  });
}

for (const gesture of [
  "hold release",
  "toggle second tap",
  "legacy NUL second tap",
  "Ctrl+C",
]) {
  test(`${gesture} cancels cold queued capture before model readiness`, async (t) => {
    const toggle = gesture === "toggle second tap";
    const h = harness(t, {
      saved: true,
      autoReady: false,
      voice: toggle ? { mode: "toggle" } : {},
    });
    h.editor.setText("draft");
    await h.emit("session_start");
    const key = gesture === "legacy NUL second tap" ? "\x00" : press;
    await h.input(key);
    assert.equal(h.controller.recordingRequested, true);
    assert.equal(h.controller.state, "loading");
    await h.input(
      gesture === "hold release"
        ? release
        : gesture === "Ctrl+C"
          ? cancel
          : key,
    );
    assert.equal(h.controller.recordingRequested, false);
    h.worker.emit({ type: "ready" });
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(h.worker.commands, []);
    for (const type of ["recording", "partial", "final"])
      h.worker.emit({ type, id: 1, text: "late unrequested speech" });
    assert.deepEqual(h.pastes, []);
    assert.equal(h.ctx.ui.getEditorText(), gesture === "Ctrl+C" ? "" : "draft");
    await h.input(release);
    const id = await h.record();
    assert.ok(id > 0, "the next gesture can start after a queued cancellation");
  });
}

test("cold model readiness rechecks focus before starting capture", async (t) => {
  const h = harness(t, { saved: true, autoReady: false });
  await h.emit("session_start");
  await h.input(press);
  h.focus(h.dialog());
  h.worker.emit({ type: "ready" });
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.recordingRequested, false);
  assert.deepEqual(h.worker.commands, []);
  await h.input(release);
  h.focus();
  await h.record();
});

test("typed Pi activity does not retain an unused model beyond its Voice idle deadline", async (t) => {
  const h = harness(t, { idleMs: 1000 });
  await h.enable();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(200);
    await h.type("typed prompt");
    await h.input("\r");
    assert.equal(h.controller.state, "ready");
  }
  t.mock.timers.tick(200);
  await tick();
  assert.equal(h.controller.state, "standby");
  assert.equal(h.worker.closed, 1);
  assert.equal(h.saved(), true);
});

test("reload cannot bypass a failed process teardown or leave inactive UI hooks", async (t) => {
  const safety = { teardownFailed: false };
  const old = harness(t, { safety });
  await old.enable();
  old.worker.close = () =>
    Promise.reject(new Error("synthetic teardown failure"));
  await old.emit("session_shutdown", { reason: "reload" });
  const next = harness(t, { safety, directory: old.directory });
  await next.emit("session_start", { reason: "reload" });
  assert.equal(next.controller.enabled, false);
  assert.equal(next.workers.length, 0);
  assert.equal(next.listeners.size, next.baselineListeners);
  assert.equal(next.widget, undefined);
  assert.match(next.notices[0].message, /Restart Pi/);
  assert.equal(next.saved(), true);
});

test("five idle minutes unload the worker without disabling Voice and on explicitly warms again", async (t) => {
  const h = harness(t);
  await h.enable();
  const old = h.worker;
  t.mock.timers.tick(299_999);
  assert.equal(h.controller.state, "ready");
  assert.equal(old.closed, 0);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(h.controller.state, "standby");
  assert.equal(h.controller.enabled, true);
  assert.equal(old.closed, 1);
  assert.equal(h.saved(), true);
  assert.match(h.renderWidget(), /standby/);
  await h.command("on");
  assert.equal(h.workers.length, 2);
  assert.equal(h.controller.state, "ready");
  assert.deepEqual(h.worker.commands, []);
  await h.emit("session_shutdown");
  t.mock.timers.tick(600_000);
  assert.equal(h.controller.state, "off");
  assert.equal(h.worker.closed, 1);
  assert.equal(h.workers.length, 2);
  assert.equal(h.saved(), true);
});

for (const action of ["shortcut", "insert", "cancel", "Ctrl+C"]) {
  test(`pending final survives injected idle unload and ${action} does not wake a model`, async (t) => {
    const h = harness(t, { idleMs: 1000, voice: { mode: "toggle" } });
    h.editor.setText("draft");
    await h.enable();
    const id = await h.record();
    await h.type(" changed");
    await h.input(press);
    h.worker.emit({ type: "final", id, text: " pending result" });
    t.mock.timers.tick(999);
    assert.equal(h.worker.closed, 0);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(h.worker.closed, 1);
    assert.equal(h.controller.state, "pending");
    assert.equal(h.controller.pendingText, " pending result");
    assert.match(h.renderWidget(), /ctrl\+space insert/);
    if (action === "shortcut") await h.input(press);
    else if (action === "Ctrl+C") await h.input(cancel);
    else await h.command(action);
    assert.equal(h.workers.length, 1);
    assert.equal(h.controller.state, "standby");
    assert.equal(h.controller.pendingText, "");
    assert.equal(h.controller.preview, "");
    const inserted = ["shortcut", "insert"].includes(action);
    assert.equal(
      h.ctx.ui.getEditorText(),
      action === "Ctrl+C"
        ? ""
        : "draft changed" + (inserted ? " pending result" : ""),
    );
    assert.deepEqual(h.pastes, inserted ? [" pending result"] : []);
    h.worker.emit({ type: "final", id, text: "duplicate speech" });
    t.mock.timers.tick(300_000);
    assert.equal(h.workers.length, 1);
    assert.equal(h.worker.closed, 1);
  });
}

test("resolved app.clear cancels before its native action, not a hardcoded Ctrl+C chord", async (t) => {
  const h = harness(t, { bindings: { "app.clear": "ctrl+alt+k" } });
  h.editor.setText("draft");
  await h.enable();
  const id = await h.record();
  await h.input(cancel);
  assert.equal(h.controller.state, "recording");
  assert.equal(h.nativeClear.mock.callCount(), 0);
  assert.equal(await h.input(kitty("k", 7)), undefined);
  assert.equal(h.controller.state, "ready");
  assert.equal(h.editor.getText(), "");
  assert.equal(h.nativeClear.mock.callCount(), 1);
  assert.deepEqual(h.worker.commands.at(-1), { type: "cancel", id });
  await h.input(release);
  await h.record();
});

test("Ctrl+C cancels recording even after focus moves to a dialog and still reaches that dialog", async (t) => {
  const h = harness(t);
  await h.enable();
  const id = await h.record();
  const dialog = h.dialog();
  dialog.setText("dialog draft");
  const clear = t.mock.fn(() => dialog.setText(""));
  dialog.onAction("app.clear", clear);
  h.focus(dialog);
  assert.equal(await h.input(cancel), undefined);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(dialog.getText(), "");
  assert.equal(h.controller.state, "ready");
  assert.deepEqual(h.worker.commands.at(-1), { type: "cancel", id });
  h.worker.emit({ type: "final", id, text: "late speech" });
  assert.deepEqual(h.pastes, []);
});

test("Ctrl+C resets a pending Space tap without inserting it into the cleared draft", async (t) => {
  const h = harness(t, { voice: { space: true } });
  h.editor.setText("draft");
  await h.enable();
  await h.input(spacePress);
  t.mock.timers.tick(299);
  assert.equal(await h.input(cancel), undefined);
  t.mock.timers.tick(1000);
  await h.input(spaceRelease);
  assert.equal(h.editor.getText(), "");
  assert.equal(h.nativeClear.mock.callCount(), 1);
  assert.deepEqual(h.worker.commands, []);
});

for (const mode of ["print", "rpc", "json"]) {
  test(`${mode} cannot enable voice or allocate resources`, async (t) => {
    const h = harness(t, {
      mode,
      preferences: {
        read: () => assert.fail("non-TUI preference read"),
        write: () => assert.fail("non-TUI preference write"),
      },
    });
    await h.emit("session_start");
    await h.command("on");
    assert.equal(h.controller.state, "off");
    assert.equal(h.workers.length, 0);
    assert.equal(h.listeners.size, h.baselineListeners);
    assert.match(h.notices[0].message, /interactive Pi/);
  });
}

test("Ctrl+Space refuses a conflicting resolved Pi binding", async (t) => {
  const h = harness(t, { bindings: { "app.session.rename": "ctrl+space" } });
  await h.command("on");
  assert.equal(h.controller.state, "off");
  assert.equal(h.workers.length, 0);
  assert.match(h.notices[0].message, /conflicts with app.session.rename/);
});

test("the previous Ctrl+Alt+V recording shortcut remains an explicit override", async (t) => {
  const h = harness(t, { voice: { shortcut: "ctrl+alt+v" } });
  await h.enable();
  await h.input(press);
  assert.deepEqual(h.worker.commands, []);
  await h.input(kitty("v", 7));
  await tick();
  assert.equal(h.controller.state, "recording");
  await h.input(kitty("v", 7, 3));
  assert.equal(h.controller.state, "finalizing");
});

test("unsupported hosts reject activation before creating a worker", async (t) => {
  const h = harness(t, {
    supported: false,
    preferences: {
      read: () => assert.fail("unsupported preference read"),
      write: () => assert.fail("unsupported preference write"),
    },
  });
  await h.emit("session_start");
  await h.command("on");
  assert.equal(h.controller.state, "off");
  assert.equal(h.workers.length, 0);
  assert.deepEqual(h.widgetCalls, []);
});

test("enabling in a real dialog editor is rejected, not mistaken for the main prompt", async (t) => {
  const h = harness(t, { dialog: true });
  await h.command("on");
  assert.equal(h.controller.state, "off");
  assert.equal(h.workers.length, 0);
  assert.equal(h.listeners.size, h.baselineListeners);
  assert.equal(h.widget, undefined);
  assert.match(h.notices[0].message, /main prompt, not a dialog/);
  h.focus();
  await h.enable();
});

test("record gestures require main focus and finals in a modal stay pending", async (t) => {
  const h = harness(t);
  await h.enable();
  const dialog = h.dialog();
  h.focus(dialog);
  await h.input(press);
  await h.command("start");
  assert.deepEqual(h.worker.commands, []);
  h.focus();
  const id = await h.record();
  await h.input(release);
  h.focus(dialog);
  h.worker.emit({ type: "final", id, text: "synthetic speech" });
  assert.equal(h.controller.state, "pending");
  assert.deepEqual(h.pastes, []);
  await h.command("insert");
  assert.equal(h.controller.state, "pending");
  assert.equal(dialog.getText(), "");
  h.focus();
  await h.input(press);
  assert.deepEqual(h.pastes, ["synthetic speech"]);
  assert.equal(h.controller.state, "ready");
  assert.equal(
    h.worker.commands.filter((event) => event.type === "start").length,
    1,
  );
});

test("hold shortcut starts once, consumes repeats, and stops once on release", async (t) => {
  const h = harness(t);
  await h.enable();
  assert.equal(parseKey(press), config.shortcut);
  assert.equal(isKeyRepeat(repeat), true);
  assert.equal(isKeyRelease(release), true);
  const id = await h.record();
  assert.deepEqual(await h.input(repeat), { consume: true });
  assert.equal(h.controller.state, "recording");
  assert.deepEqual(await h.input(release), { consume: true });
  assert.equal(h.controller.state, "finalizing");
  await h.input(release);
  assert.deepEqual(h.worker.commands, [
    { type: "start", id },
    { type: "stop", id },
  ]);
  assert.equal(h.editor.getText(), "");
});

test("recording widget counts down from 10 to 1 before the unchanged 60-second stop", async (t) => {
  const h = harness(t);
  await h.enable();
  const id = await h.record();
  const initialRenders = h.widgetCalls.length;
  t.mock.timers.tick(49_999);
  assert.doesNotMatch(h.renderWidget(), /s left/);
  assert.equal(h.widgetCalls.length, initialRenders);
  t.mock.timers.tick(1);
  for (let seconds = 10; seconds > 0; seconds--) {
    assert.match(
      h.renderWidget(),
      new RegExp(`● recording · ${seconds}s left`),
    );
    assert.equal(h.widgetCalls.length, initialRenders + 11 - seconds);
    assert.deepEqual(h.worker.commands, [{ type: "start", id }]);
    t.mock.timers.tick(1000);
  }
  assert.match(h.renderWidget(), /voice · finalizing/);
  assert.doesNotMatch(h.renderWidget(), /s left/);
  assert.deepEqual(h.worker.commands.at(-1), { type: "stop", id });
  h.worker.emit({ type: "final", id, text: "synthetic speech" });
  assert.deepEqual(h.pastes, ["synthetic speech"]);
  assert.deepEqual(h.submissions, []);
});

for (const end of ["release", "cancel", "final", "shutdown"]) {
  test(`${end} clears the recording countdown and its redraws`, async (t) => {
    const h = harness(t);
    await h.enable();
    const id = await h.record();
    t.mock.timers.tick(53_500);
    assert.match(h.renderWidget(), /7s left/);
    if (end === "release") await h.input(release);
    if (end === "cancel") await h.command("cancel");
    if (end === "final")
      h.worker.emit({ type: "final", id, text: "synthetic speech" });
    if (end === "shutdown") await h.emit("session_shutdown");
    assert.doesNotMatch(h.renderWidget(), /s left/);
    const renders = h.widgetCalls.length;
    t.mock.timers.tick(7000);
    assert.equal(h.widgetCalls.length, renders);
  });
}

for (const modifiers of [1, 3, 5]) {
  test(`base-key release stops holding after modifiers change to ${modifiers}`, async (t) => {
    const h = harness(t);
    await h.enable();
    const id = await h.record();
    await h.input(kitty(57442, 1, 3)); // Left Ctrl released first.
    await h.input(kitty(57443, 1, 3)); // Left Alt released first.
    assert.equal(h.controller.state, "recording");
    await h.input(kitty(" ", modifiers, 3));
    assert.equal(h.controller.state, "finalizing");
    assert.deepEqual(h.worker.commands.at(-1), { type: "stop", id });
  });
}

for (const [name, options, data] of [
  ["legacy Ctrl+Space NUL", { protocol: false }, "\x00"],
  ["missing release protocol", { protocol: false }, press],
  ["explicit toggle mode", { voice: { mode: "toggle" } }, press],
]) {
  test(`${name} toggles capture instead of depending on release`, async (t) => {
    const h = harness(t, options);
    await h.enable();
    assert.equal(parseKey(data), config.shortcut);
    await h.input(data);
    assert.equal(h.controller.state, "recording");
    await h.input(release);
    assert.equal(h.controller.state, "recording");
    await h.input(data);
    assert.equal(h.controller.state, "finalizing");
    assert.deepEqual(
      h.worker.commands.map((event) => event.type),
      ["start", "stop"],
    );
  });
}

test("Escape and agent abort notifications do not cancel late finals or change Normal on delivery", async (t) => {
  const h = harness(t);
  h.editor.setText("draft");
  await h.enable();
  const id = await h.record();
  await h.input(release);
  assert.equal(await h.input(esc), undefined);
  assertMode(h.editor, "NORMAL");
  assert.equal(h.interrupts, 0);
  await h.emit("agent_end", { aborted: true });
  await h.emit("agent_settled", { aborted: true });
  h.worker.emit({ type: "final", id, text: "dd cw literal" });
  assert.equal(h.ctx.ui.getEditorText(), "drafdd cw literalt");
  assertMode(h.editor, "NORMAL");
  assert.deepEqual(
    h.worker.commands.map((event) => event.type),
    ["start", "stop"],
  );
  await h.input(esc);
  assert.equal(h.interrupts, 1, "Normal Escape still reaches Pi");
});

test("Normal f followed by encoded Space remains a literal Vim search target", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  normalAtStart(h.editor, "a b c");
  await h.input("f");
  assert.match(h.editor.render(80).at(-1), /f · NORMAL/);
  assert.equal(h.editor.acceptsLiteralSpace, false);
  assert.equal(await h.input(spacePress), undefined);
  t.mock.timers.tick(300);
  await h.input(spaceRelease);
  assert.deepEqual(h.editor.getCursor(), { line: 0, col: 1 });
  assert.equal(h.editor.getText(), "a b c");
  assert.deepEqual(h.worker.commands, []);
  assertMode(h.editor, "NORMAL");
});

for (const operator of ["c", "d"]) {
  test(`voice activation and Space settings leave pending Vim ${operator} untouched`, async (t) => {
    const h = harness(t);
    normalAtStart(h.editor, "alpha beta");
    await h.input(operator);
    const border = h.editor.render(80).at(-1);
    assert.match(border, new RegExp(`${operator} · NORMAL`));
    await h.enable();
    await h.command("space on");
    assert.equal(h.editor.render(80).at(-1), border);
    assert.equal(h.editor.acceptsLiteralSpace, false);
    await h.input("w");
    assert.equal(h.editor.getText(), operator === "c" ? " beta" : "beta");
    assertMode(h.editor, operator === "c" ? "INSERT" : "NORMAL");
    assert.deepEqual(h.worker.commands, []);
  });
}

const completion = {
  async getSuggestions() {
    return { prefix: "/", items: [{ value: "/fixture", label: "fixture" }] };
  },
  applyCompletion() {
    return { lines: ["/fixture "], cursorLine: 0, cursorCol: 9 };
  },
};

for (const editor of ["vim", "stock"]) {
  test(`${editor} autocomplete excludes hold-Space interception`, async (t) => {
    const h = harness(t, { editor, voice: { space: true } });
    await h.enable();
    h.editor.setAutocompleteProvider(completion);
    await h.input("/");
    await tick();
    assert.equal(h.editor.isShowingAutocomplete(), true);
    assert.equal(await h.input(spacePress), undefined);
    t.mock.timers.tick(300);
    await h.input(spaceRelease);
    assert.equal(h.ctx.ui.getEditorText(), "/ ");
    assert.deepEqual(h.worker.commands, []);
  });

  test(`${editor} native jump accepts literal Space instead of starting voice`, async (t) => {
    const h = harness(t, { editor, voice: { space: true } });
    await h.enable();
    h.editor.setText("a b c");
    await h.input("\x01"); // Native line start.
    await h.input("\x1d"); // Native jump forward.
    if (editor === "vim") assert.equal(h.editor.acceptsLiteralSpace, false);
    assert.equal(await h.input(spacePress), undefined);
    t.mock.timers.tick(300);
    await h.input(spaceRelease);
    assert.deepEqual(h.editor.getCursor(), { line: 0, col: 1 });
    assert.equal(h.editor.getText(), "a b c");
    assert.deepEqual(h.worker.commands, []);
  });
}

test("provisional previews replace only the widget, never a typed draft", async (t) => {
  const h = harness(t, { voice: { mode: "toggle" } });
  h.editor.setText("draft ");
  await h.enable();
  const id = await h.record();
  h.worker.emit({ type: "partial", id, text: "first preview" });
  assert.equal(h.ctx.ui.getEditorText(), "draft ");
  assert.match(h.renderWidget(), /first preview/);
  await h.type("typed");
  h.worker.emit({ type: "partial", id, text: "replacement preview" });
  assert.equal(h.ctx.ui.getEditorText(), "draft typed");
  assert.match(h.renderWidget(), /replacement preview/);
  assert.doesNotMatch(h.renderWidget(), /first preview/);
  assert.deepEqual(h.pastes, []);
});

for (const editor of ["vim", "stock"]) {
  for (const normal of editor === "vim" ? [false, true] : [false]) {
    test(`${editor} ${normal ? "Normal" : "Insert"} final is one literal paste and one undo`, async (t) => {
      const h = harness(t, { editor });
      if (normal) normalAtStart(h.editor, "original");
      else {
        h.editor.setText("original");
        await h.type(" typed");
      }
      const before = h.ctx.ui.getEditorText();
      await h.enable();
      const id = await h.record();
      await h.input(release);
      const transcript = "dd cw xui\n/voice off";
      h.worker.emit({ type: "final", id, text: transcript });
      assert.deepEqual(h.pastes, [transcript]);
      assert.equal(
        h.ctx.ui.getEditorText(),
        normal ? transcript + before : before + transcript,
      );
      assert.deepEqual(h.submissions, []);
      if (editor === "vim") assertMode(h.editor, normal ? "NORMAL" : "INSERT");
      await h.input(normal ? "u" : "\x1f");
      assert.equal(
        h.ctx.ui.getEditorText(),
        before,
        "one undo removes the whole final only",
      );
    });
  }
}

test("expanded collapsed-paste drafts are compared without replacing their contents", async (t) => {
  const h = harness(t);
  const original = Array.from(
    { length: 15 },
    (_, i) => `fixture line ${i}`,
  ).join("\n");
  await h.input(paste(original));
  assert.match(h.editor.getText(), /paste #1/);
  assert.equal(h.ctx.ui.getEditorText(), original);
  await h.enable();
  const id = await h.record();
  await h.input(release);
  h.worker.emit({ type: "final", id, text: " literal final" });
  assert.equal(h.ctx.ui.getEditorText(), original + " literal final");
  await h.input("\x1f");
  assert.equal(h.ctx.ui.getEditorText(), original);
});

test("a changed draft keeps the final pending until the record shortcut explicitly inserts", async (t) => {
  const h = harness(t, { voice: { mode: "toggle" } });
  h.editor.setText("draft");
  await h.enable();
  const id = await h.record();
  await h.type(" changed");
  await h.input(press);
  h.worker.emit({ type: "final", id, text: " spoken" });
  assert.equal(h.controller.state, "pending");
  assert.equal(h.controller.pendingText, " spoken");
  assert.equal(h.ctx.ui.getEditorText(), "draft changed");
  assert.deepEqual(h.pastes, []);
  assert.match(h.renderWidget(), /ctrl\+space insert/);
  await h.input(press);
  await h.input(release);
  assert.equal(h.ctx.ui.getEditorText(), "draft changed spoken");
  assert.deepEqual(h.pastes, [" spoken"]);
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.pendingText, "");
  assert.deepEqual(
    h.worker.commands.map((event) => event.type),
    ["start", "stop"],
  );
});

for (const editor of ["vim", "stock"]) {
  for (const phase of ["recording", "finalizing", "pending"]) {
    test(`${editor} Ctrl+C clears the draft and retires ${phase} speech before native clear`, async (t) => {
      const h = harness(t, { editor, voice: { mode: "toggle" } });
      h.editor.setText("draft");
      await h.enable();
      const id = await h.record();
      await h.type(" changed");
      h.worker.emit({ type: "partial", id, text: "synthetic preview" });
      if (phase !== "recording") await h.input(press);
      if (phase === "pending")
        h.worker.emit({ type: "final", id, text: "synthetic result" });
      assert.equal(h.controller.state, phase);
      h.editor.onAction("app.clear", () => {
        assert.equal(h.controller.recordingRequested, false);
        assert.equal(h.controller.pendingText, "");
        assert.equal(h.controller.preview, "");
        h.nativeClear();
      });
      assert.equal(await h.input(cancel), undefined);
      assert.equal(h.controller.state, "ready");
      assert.equal(h.ctx.ui.getEditorText(), "");
      assert.equal(h.nativeClear.mock.callCount(), 1);
      if (editor === "vim") assertMode(h.editor, "INSERT");
      if (phase !== "pending")
        assert.deepEqual(h.worker.commands.at(-1), { type: "cancel", id });
      for (const type of ["recording", "partial", "final", "cancelled"])
        h.worker.emit({ type, id, text: "late retired speech" });
      assert.equal(h.ctx.ui.getEditorText(), "");
      assert.deepEqual(h.pastes, []);
      await h.input(cancel);
      assert.equal(
        h.nativeClear.mock.callCount(),
        2,
        "Voice must not swallow Pi's second clear/exit action",
      );
      await h.type("new draft");
      const next = await h.record();
      assert.ok(next > id);
      h.worker.emit({ type: "final", id, text: "retired final" });
      assert.equal(h.ctx.ui.getEditorText(), "new draft");
      await h.input(press);
      h.worker.emit({ type: "final", id: next, text: " current result" });
      assert.equal(h.ctx.ui.getEditorText(), "new draft current result");
    });
  }
}

test("interactive submission retires active IDs before the next prompt", async (t) => {
  const h = harness(t, { voice: { mode: "toggle" } });
  h.editor.setText("first prompt");
  await h.enable();
  const id = await h.record();
  h.worker.emit({ type: "partial", id, text: "old preview" });
  await h.input("\r");
  assert.deepEqual(h.submissions, ["first prompt"]);
  assert.equal(h.controller.state, "ready");
  assert.deepEqual(h.worker.commands.at(-1), { type: "cancel", id });
  await h.type("next prompt");
  await h.input(release);
  const next = await h.record();
  assert.ok(next > id);
  for (const type of ["recording", "partial", "final", "cancelled"])
    h.worker.emit({ type, id, text: "retired speech" });
  assert.equal(h.controller.state, "recording");
  assert.equal(h.ctx.ui.getEditorText(), "next prompt");
  assert.deepEqual(h.pastes, []);
  await h.input(release);
  h.worker.emit({ type: "final", id: next, text: " current speech" });
  assert.equal(h.ctx.ui.getEditorText(), "next prompt current speech");
});

for (const command of ["/session", "/fixture-extension"]) {
  test(`command submission ${command} retires voice without an input event`, async (t) => {
    const h = harness(t);
    await h.enable();
    const id = await h.record();
    await h.input(release);
    await h.type(command);
    await h.input("\r");
    assert.equal(h.controller.state, "ready");
    h.worker.emit({ type: "final", id, text: "late result" });
    assert.equal(h.ctx.ui.getEditorText(), "");
    assert.deepEqual(h.pastes, []);
  });
}

test("submitted voice stop remains usable and submit hooks are restored on disable", async (t) => {
  const h = harness(t, { voice: { mode: "toggle" } });
  const original = h.editor.onSubmit;
  await h.enable();
  const id = await h.record();
  await h.type("/voice stop");
  await h.input("\r");
  assert.equal(h.controller.state, "finalizing");
  assert.deepEqual(h.worker.commands.at(-1), { type: "stop", id });
  h.worker.emit({ type: "final", id, text: "voice result" });
  assert.equal(h.ctx.ui.getEditorText(), "voice result");
  await h.command("off");
  assert.equal(h.editor.onSubmit, original);
});

for (const [binding, data] of [
  ["ctrl+z", "\x1a"],
  ["ctrl+alt+s", kitty("s", 7)],
]) {
  test(`resolved suspend ${binding} cancels detached capture and releases the gesture`, async (t) => {
    const h = harness(t, { bindings: { "app.suspend": binding } });
    await h.enable();
    const id = await h.record();
    await h.input(data);
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(h.worker.commands.at(-1), { type: "cancel", id });
    await h.input(release);
    assert.equal(h.controller.state, "ready");
    h.worker.emit({ type: "final", id, text: "late result" });
    assert.deepEqual(h.pastes, []);
  });
}

for (const data of [paste("X"), "e\u0301", "你好"]) {
  test(`pending Space tap precedes ${JSON.stringify(data)} without starting capture`, async (t) => {
    const h = harness(t, { voice: { space: true } });
    await h.enable();
    await h.input(spacePress);
    await h.input(data);
    t.mock.timers.tick(300);
    await h.input(spaceRelease);
    assert.equal(
      h.ctx.ui.getEditorText(),
      " " + (data.startsWith("\x1b") ? "X" : data),
    );
    assert.deepEqual(h.worker.commands, []);
  });
}

test("a consumed short Space release schedules an immediate editor redraw", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  await h.input(spacePress);
  const before = h.tui.requestRender.mock.callCount();
  await h.input(spaceRelease);
  assert.equal(h.editor.getText(), " ");
  assert.ok(h.tui.requestRender.mock.callCount() > before);
});

for (const [binding, data] of [
  ["alt+enter", "\x1b[13;3u"],
  ["ctrl+alt+f", kitty("f", 7)],
]) {
  test(`resolved follow-up ${binding} retires capture even when onSubmit is bypassed`, async (t) => {
    const h = harness(t, {
      bindings: { "app.message.followUp": binding },
      voice: { mode: "toggle" },
    });
    h.editor.onAction("app.message.followUp", () => {
      h.submissions.push(h.ctx.ui.getEditorText());
      h.editor.setText("");
    });
    await h.enable();
    const id = await h.record();
    await h.type("follow-up");
    await h.input(data);
    assert.deepEqual(h.submissions, ["follow-up"]);
    assert.equal(h.controller.state, "ready");
    h.worker.emit({ type: "final", id, text: "late result" });
    assert.equal(h.ctx.ui.getEditorText(), "");
    assert.deepEqual(h.pastes, []);
  });
}

test("hold-Space reporting recovers after asynchronous resume negotiation without another render", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  h.renderWidget();
  await h.input("\x1a");
  h.tui.terminal.kittyProtocolActive = false;
  h.widget.invalidate();
  h.renderWidget();
  const before = h.writes.length;
  const renders = h.tui.requestRender.mock.callCount();
  h.tui.terminal.kittyProtocolActive = true;
  t.mock.timers.tick(25);
  assert.ok(h.writes.slice(before).includes("\x1b[=8;2u"));
  assert.ok(h.tui.requestRender.mock.callCount() > renders);
  assert.deepEqual(h.worker.commands, []);
});

test("disabling voice clears pending keyboard-negotiation retries", async (t) => {
  const h = harness(t, { voice: { space: true }, protocol: false });
  await h.enable();
  h.renderWidget();
  await h.command("off");
  const before = h.writes.length;
  h.tui.terminal.kittyProtocolActive = true;
  t.mock.timers.tick(2000);
  assert.equal(h.writes.length, before);
});

test("noninteractive input does not retire the main prompt's recording", async (t) => {
  const h = harness(t);
  await h.enable();
  const id = await h.record();
  await h.emit("input", { source: "rpc", text: "fixture request" });
  assert.equal(h.controller.state, "recording");
  assert.deepEqual(h.worker.commands, [{ type: "start", id }]);
});

for (const cancelShortcut of ["ctrl+alt+x", "ctrl+alt+b", null, 42]) {
  test(`legacy cancelShortcut ${JSON.stringify(cancelShortcut)} is accepted centrally but never registered`, async (t) => {
    const h = harness(t, {
      voice: { cancelShortcut, device: ":2", mode: "toggle" },
    });
    assert.deepEqual([...h.shortcuts.keys()], [config.shortcut]);
    assert.deepEqual(readConfig(h.configFile).voice, {
      ...config,
      device: ":2",
      mode: "toggle",
    });
    h.editor.setText("draft");
    await h.enable();
    assert.equal(h.worker.callbacks.device, ":2");
    const id = await h.record();
    await h.input(esc);
    assertMode(h.editor, "NORMAL");
    assert.equal(h.controller.state, "recording");
    for (const chord of [oldCancel, kitty("b", 7)]) {
      assert.equal(await h.input(chord), undefined);
      assert.equal(h.controller.state, "recording");
    }
    assert.equal(h.ctx.ui.getEditorText(), "draft");
    h.renderWidget();
    await h.input(cancel);
    assert.equal(h.ctx.ui.getEditorText(), "");
    assert.equal(h.controller.state, "ready");
    assert.deepEqual(h.worker.commands, [
      { type: "start", id },
      { type: "cancel", id },
    ]);
    h.worker.emit({ type: "final", id, text: "late speech" });
    assert.deepEqual(h.pastes, []);
  });
}

test("Space tap is native typing and Escape flushes it before reaching Vim", async (t) => {
  const h = harness(t, { voice: { space: true } });
  h.editor.setText("draft");
  await h.enable();
  assert.deepEqual(await h.input(spacePress), { consume: true });
  assert.equal(h.ctx.ui.getEditorText(), "draft");
  t.mock.timers.tick(299);
  assert.equal(await h.input(esc), undefined);
  assert.equal(h.ctx.ui.getEditorText(), "draft ");
  assertMode(h.editor, "NORMAL");
  assert.equal(h.interrupts, 0);
  await h.input(spaceRelease);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.worker.commands, []);
  assert.deepEqual(h.pastes, [], "a tap is not transcript paste");
});

test("hold-Space starts only after the threshold and stops on release", async (t) => {
  const h = harness(t, { voice: { space: true } });
  h.editor.setText("draft");
  await h.enable();
  await h.input(spacePress);
  t.mock.timers.tick(299);
  assert.deepEqual(h.worker.commands, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(h.controller.state, "recording");
  await h.input(kitty(" ", 1, 2));
  await h.input(spaceRelease);
  assert.deepEqual(
    h.worker.commands.map((event) => event.type),
    ["start", "stop"],
  );
  assert.equal(h.ctx.ui.getEditorText(), "draft");
});

test("Space in Normal passes through without a timer, text insertion or recording", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  normalAtStart(h.editor, "a b");
  assert.equal(await h.input(spacePress), undefined);
  t.mock.timers.tick(1000);
  await h.input(spaceRelease);
  assert.equal(h.editor.getText(), "a b");
  assertMode(h.editor, "NORMAL");
  assert.deepEqual(h.worker.commands, []);
});

test("missing release protocol preserves ordinary Space and advertises toggle fallback", async (t) => {
  const h = harness(t, { protocol: false, voice: { space: true } });
  await h.enable();
  await h.input(" ");
  await h.input(spacePress);
  t.mock.timers.tick(1000);
  assert.equal(h.editor.getText(), "  ");
  assert.deepEqual(h.worker.commands, []);
  assert.match(h.renderWidget(), /toggle ctrl\+space/);
  assert.doesNotMatch(h.renderWidget(), /or Space/);
  assert.deepEqual(h.writes, []);
  await h.input("\x00");
  assert.equal(h.controller.state, "recording");
  await h.input("\x00");
  assert.equal(h.controller.state, "finalizing");
});

test("report-all-keys adds/removes only its flag, without pushing a Kitty stack frame", async (t) => {
  const h = harness(t);
  await h.enable();
  h.renderWidget();
  assert.deepEqual(h.writes, []);
  await h.command("space on");
  h.renderWidget();
  h.renderWidget();
  assert.deepEqual(h.writes, ["\x1b[=8;2u"]);
  h.widget.invalidate();
  h.renderWidget();
  assert.deepEqual(h.writes, ["\x1b[=8;2u", "\x1b[=8;2u"]);
  await h.command("space off");
  h.renderWidget();
  assert.equal(h.writes.at(-1), "\x1b[=8;3u");
  await h.command("space on");
  h.renderWidget();
  await h.command("off");
  assert.deepEqual(h.writes.slice(-2), ["\x1b[=8;2u", "\x1b[=8;3u"]);
  assert.ok(h.writes.every((data) => /^\x1b\[=8;[23]u$/.test(data)));
  assert.equal(h.listeners.size, h.baselineListeners);
  assert.equal(h.widget, undefined);
});

test("suspend clears reporting before Pi stops and renderer invalidation reapplies it", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  h.renderWidget();
  assert.equal(await h.input("\x1a"), undefined);
  assert.deepEqual(h.writes, ["\x1b[=8;2u", "\x1b[=8;3u"]);
  h.tui.terminal.kittyProtocolActive = false;
  h.widget.invalidate();
  h.renderWidget();
  assert.equal(h.writes.length, 2);
  h.tui.terminal.kittyProtocolActive = true;
  h.widget.invalidate();
  h.renderWidget();
  assert.equal(h.writes.at(-1), "\x1b[=8;2u");
  await h.command("off");
  assert.equal(h.writes.at(-1), "\x1b[=8;3u");
});

test("disable after renderer invalidation cancels a pending Space timer and reporting", async (t) => {
  const h = harness(t, { voice: { space: true } });
  await h.enable();
  h.renderWidget();
  await h.input(spacePress);
  h.widget.invalidate();
  await h.command("off");
  t.mock.timers.tick(1000);
  assert.equal(h.controller.state, "off");
  assert.deepEqual(h.worker.commands, []);
  assert.equal(h.worker.closed, 1);
  assert.equal(h.editor.getText(), "");
  assert.deepEqual(h.writes, ["\x1b[=8;2u", "\x1b[=8;3u"]);
});

test("session shutdown tears down worker, listener and flags and ignores all late callbacks", async (t) => {
  const h = harness(t, { voice: { space: true } });
  h.editor.setText("draft");
  await h.enable();
  h.renderWidget();
  const id = await h.record();
  h.worker.emit({ type: "partial", id, text: "temporary speech" });
  await h.emit("session_shutdown", { reason: "reload" });
  assert.equal(h.controller.state, "off");
  assert.equal(h.controller.preview, "");
  assert.equal(h.worker.closed, 1);
  assert.equal(h.listeners.size, h.baselineListeners);
  assert.equal(h.widget, undefined);
  assert.deepEqual(h.writes, ["\x1b[=8;2u", "\x1b[=8;3u"]);
  h.worker.emit({ type: "ready" });
  h.worker.emit({ type: "final", id, text: "late speech" });
  h.worker.callbacks.onError(new Error("synthetic late error"));
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(h.worker.closed, 1);
  assert.equal(h.ctx.ui.getEditorText(), "draft");
  assert.deepEqual(h.pastes, []);
  assert.deepEqual(h.notices, []);
});

test("VoiceKeys dedicated hold starts once, ignores repeat and stops on release", (t) => {
  const h = keysHarness(t);
  assert.deepEqual(h.input(press), { consume: true });
  assert.deepEqual(h.input(repeat), { consume: true });
  assert.deepEqual(h.actions, ["start"]);
  assert.deepEqual(h.input(release), { consume: true });
  h.input(release);
  assert.deepEqual(h.actions, ["start", "stop"]);
});

for (const modifiers of [1, 3, 5]) {
  test(`VoiceKeys releases the base key even when its modifiers become ${modifiers}`, (t) => {
    const h = keysHarness(t);
    h.input(press);
    h.input(kitty(57442, 1, 3));
    h.input(kitty(57443, 1, 3));
    assert.deepEqual(h.actions, ["start"]);
    assert.deepEqual(h.input(kitty(" ", modifiers, 3)), { consume: true });
    assert.deepEqual(h.actions, ["start", "stop"]);
  });
}

for (const [name, options, data] of [
  ["legacy Ctrl+Space NUL", {}, "\x00"],
  ["no release protocol", { context: { releaseSupported: false } }, press],
  ["explicit toggle", { mode: "toggle" }, press],
]) {
  test(`VoiceKeys ${name} starts/stops on successive presses, not release`, (t) => {
    const h = keysHarness(t, options);
    h.input(data);
    h.input(release);
    assert.deepEqual(h.actions, ["start"]);
    h.input(data);
    assert.deepEqual(h.actions, ["start", "stop"]);
  });
}

test("VoiceKeys pending shortcut requests insertion without arming a held recording", (t) => {
  const h = keysHarness(t, { context: { ready: false, pending: true } });
  h.input(press);
  h.input(release);
  assert.deepEqual(h.actions, ["start"]);
});

test("VoiceKeys dedicated recording also works when literal Space is excluded", (t) => {
  const h = keysHarness(t, { context: { spaceAllowed: false } });
  h.input(press);
  h.input(release);
  assert.deepEqual(h.actions, ["start", "stop"]);
});

test("VoiceKeys Escape and Ctrl+C pass through without canceling active dictation", (t) => {
  const h = keysHarness(t);
  h.input(press);
  assert.equal(h.input(esc), undefined);
  assert.equal(h.input("\x03"), undefined);
  assert.deepEqual(h.actions, ["start"]);
  h.input(release);
  assert.deepEqual(h.actions, ["start", "stop"]);
});

test("VoiceKeys honors only its configured recording chord and owns no cancel key", (t) => {
  const h = keysHarness(t, { shortcut: "ctrl+alt+b" });
  assert.equal(h.input(press), undefined);
  assert.equal(h.input(oldCancel), undefined);
  assert.equal(h.input(cancel), undefined);
  h.input(kitty("b", 7));
  assert.equal(h.input(kitty("n", 7)), undefined);
  assert.equal(h.input(oldCancel), undefined);
  h.input(kitty("b", 1, 3));
  assert.deepEqual(h.actions, ["start", "stop"]);
});

test("VoiceKeys reset drops a pending Space tap without flushing it", (t) => {
  const h = keysHarness(t);
  h.input(spacePress);
  h.keys.reset();
  t.mock.timers.tick(1000);
  h.input(spaceRelease);
  assert.deepEqual(h.actions, []);
});

test("VoiceKeys quick Space tap emits exactly one ordinary Space", (t) => {
  const h = keysHarness(t);
  assert.deepEqual(h.input(spacePress), { consume: true });
  t.mock.timers.tick(299);
  h.input(kitty(" ", 1, 2));
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.input(spaceRelease), { consume: true });
  t.mock.timers.tick(1000);
  h.input(spaceRelease);
  assert.deepEqual(h.actions, ["space"]);
});

test("VoiceKeys hold threshold starts once despite repeats, then releases once", (t) => {
  const h = keysHarness(t);
  h.input(spacePress);
  t.mock.timers.tick(299);
  assert.deepEqual(h.actions, []);
  t.mock.timers.tick(1);
  h.input(kitty(" ", 1, 2));
  t.mock.timers.tick(1000);
  assert.deepEqual(h.actions, ["start"]);
  h.input(spaceRelease);
  h.input(spaceRelease);
  assert.deepEqual(h.actions, ["start", "stop"]);
});

for (const next of ["x", esc]) {
  test(`VoiceKeys pending Space flushes before ${next === esc ? "Escape" : "ordinary input"} without consuming it`, (t) => {
    const h = keysHarness(t);
    h.input(spacePress);
    assert.equal(h.input(next), undefined);
    h.input(spaceRelease);
    t.mock.timers.tick(1000);
    assert.deepEqual(h.actions, ["space"]);
  });
}

for (const field of ["atMain", "spaceAllowed", "ready"]) {
  test(`VoiceKeys rechecks ${field} at the Space hold deadline`, (t) => {
    const h = keysHarness(t);
    h.input(spacePress);
    h.context[field] = false;
    t.mock.timers.tick(300);
    h.input(spaceRelease);
    assert.deepEqual(h.actions, []);
  });
}

for (const field of [
  "enabled",
  "atMain",
  "releaseSupported",
  "spaceEnabled",
  "spaceAllowed",
  "ready",
]) {
  test(`VoiceKeys leaves encoded Space alone when ${field} is false`, (t) => {
    const h = keysHarness(t, { context: { [field]: false } });
    assert.equal(h.input(spacePress), undefined);
    t.mock.timers.tick(1000);
    h.input(spaceRelease);
    assert.deepEqual(h.actions, []);
  });
}

test("VoiceKeys unencoded Space is never treated as a hold gesture", (t) => {
  const h = keysHarness(t);
  assert.equal(h.input(" "), undefined);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.actions, []);
});

test("VoiceKeys reset clears pending tap and held shortcut without delayed effects", (t) => {
  const h = keysHarness(t);
  h.input(spacePress);
  h.keys.reset();
  t.mock.timers.tick(1000);
  h.input(spaceRelease);
  assert.deepEqual(h.actions, []);
  h.input(press);
  h.keys.reset();
  h.input(release);
  assert.deepEqual(h.actions, ["start"]);
});

test("VoiceKeys ignores initial repeats/releases and passes the removed chord through in every event form", (t) => {
  const h = keysHarness(t);
  h.input(repeat);
  h.input(release);
  assert.deepEqual(h.actions, []);
  h.input(press);
  for (const event of [1, 2, 3])
    assert.equal(h.input(kitty("x", 7, event)), undefined);
  h.input(release);
  assert.deepEqual(h.actions, ["start", "stop"]);
});

test("VoiceKeys leaves Ctrl+C and Escape to its caller even after focus moves to a modal", (t) => {
  const h = keysHarness(t);
  h.input(press);
  h.context.atMain = false;
  for (const key of [cancel, esc, oldCancel])
    assert.equal(h.input(key), undefined);
  assert.deepEqual(h.actions, ["start"]);
  h.keys.reset();
  h.input(release);
  assert.deepEqual(h.actions, ["start"]);
});
