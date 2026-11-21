import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { defaults, readConfig } from "../lib/config.mjs";

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
const { installPolish, DEFAULT_RULES } = await jiti.import(
  join(root, "extensions/polish/index.ts"),
);
const { VimEditor } = await jiti.import(join(root, "extensions/vim/index.ts"));
const { CustomEditor, initTheme } = await jiti.import(
  alias["@earendil-works/pi-coding-agent"],
);
// The loader's cancel hint reads Pi's global theme.
initTheme("dark");
const { KeybindingsManager } = await jiti.import(
  join(packageDir, "dist/core/keybindings.js"),
);
const { matchesKey, setKeybindings, setKittyProtocolActive } =
  await jiti.import(alias["@earendil-works/pi-tui"]);

const RULES = "# Polish rules\n\nSynthetic rule: fix the grammar.\n";
const config = {
  rulesFile: "/rules/rules.md",
  shortcut: "ctrl+alt+p",
  model: null,
};
// Kitty encodes ctrl+alt as modifier 7 (1 + alt 2 + ctrl 4).
const shortcut = "\x1b[112;7u";
const identity = (text) => text;
const theme = {
  fg: (_color, text) => text,
  bold: identity,
  borderColor: identity,
};
const sessionModel = { provider: "test", id: "session-model", reasoning: true };
const otherModel = { provider: "other", id: "plain-model", reasoning: false };

function reply(text, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content: text === undefined ? [] : [{ type: "text", text }],
    stopReason,
    errorMessage,
  };
}

function harness(t, options = {}) {
  setKittyProtocolActive(true);
  t.after(() => setKittyProtocolActive(false));
  const bindings = new KeybindingsManager({});
  setKeybindings(bindings);
  const tui = {
    requestRender: t.mock.fn(),
    terminal: { rows: 30, columns: 80 },
  };
  const Editor = options.editor === "stock" ? CustomEditor : VimEditor;
  const editor = new Editor(tui, theme, bindings);
  editor.focused = true;
  const commands = new Map();
  const shortcuts = new Map();
  const notices = [];
  const requests = [];
  const pending = [];
  let respond = options.respond ?? (() => reply("Polished text."));
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    registerShortcut: (key, definition) => shortcuts.set(key, definition),
    sendUserMessage: () => assert.fail("Polish must not submit a prompt"),
    on: () => assert.fail("Polish needs no event hooks"),
  };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    model: "model" in options ? options.model : sessionModel,
    modelRegistry: {
      find: (provider, id) =>
        provider === otherModel.provider && id === otherModel.id
          ? otherModel
          : undefined,
      streamSimple(model, context, streamOptions) {
        const call = { model, context, options: streamOptions };
        requests.push(call);
        return { result: async () => respond(call) };
      },
    },
    ui: {
      getEditorText: () => editor.getExpandedText(),
      setEditorText: (text) => editor.setText(text),
      notify: (message, level) => notices.push({ message, level }),
      // Pi saves the draft, shows the component, then restores the draft
      // and disposes the component once it finishes.
      custom(factory) {
        const saved = editor.getExpandedText();
        return new Promise((done) => {
          let component;
          const close = (result) => {
            editor.setText(saved);
            done(result);
            component?.dispose?.();
          };
          component = factory(tui, theme, bindings, close);
          if (options.onCustom) options.onCustom(component);
        });
      },
    },
  };
  installPolish(pi, {
    config: { ...config, ...options.config },
    readRules:
      options.readRules ??
      ((path) => {
        assert.equal(path, "/rules/rules.md");
        return RULES;
      }),
  });
  editor.onSubmit = (text) => {
    // Pi dispatches extension commands before its input event.
    const [, name, args = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? [];
    const command = commands.get(name);
    assert.ok(command, `unexpected submission: ${text}`);
    pending.push(Promise.resolve(command.handler(args, ctx)));
  };
  editor.onExtensionShortcut = (data) => {
    for (const [key, definition] of shortcuts) {
      if (!matchesKey(data, key)) continue;
      pending.push(Promise.resolve(definition.handler(ctx)));
      return true;
    }
    return false;
  };
  return {
    editor,
    commands,
    shortcuts,
    notices,
    requests,
    ctx,
    set respond(value) {
      respond = value;
    },
    type(text) {
      for (const char of text) editor.handleInput(char);
    },
    async press(data) {
      editor.handleInput(data);
      await Promise.all(pending.splice(0));
    },
  };
}

test("polish registers one command and the configured shortcut", (t) => {
  const h = harness(t);
  assert.deepEqual([...h.commands.keys()], ["polish"]);
  assert.deepEqual([...h.shortcuts.keys()], ["ctrl+alt+p"]);
  assert.equal(DEFAULT_RULES, "~/.agents/skills/polish-text/rules.md");
});

for (const editor of ["vim", "stock"]) {
  test(`${editor} shortcut polishes the draft in place and one undo restores it`, async (t) => {
    const h = harness(t, { editor });
    h.type("um so plz fix teh loader");
    await h.press(shortcut);
    assert.equal(h.editor.getExpandedText(), "Polished text.");
    assert.equal(h.requests.length, 1);
    const [{ model, context, options }] = h.requests;
    assert.equal(model, sessionModel);
    assert.equal(options.reasoning, "low");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(context.systemPrompt.startsWith(RULES.trim()));
    assert.match(context.systemPrompt, /Return only the polished text\./);
    assert.deepEqual(
      context.messages.map((message) => message.content),
      [[{ type: "text", text: "um so plz fix teh loader" }]],
    );
    assert.deepEqual(h.notices, [
      { message: "Polished. Undo restores your draft.", level: "info" },
    ]);
    if (editor === "vim") await h.press("\x1b");
    await h.press(editor === "vim" ? "u" : "\x1f");
    assert.equal(h.editor.getExpandedText(), "um so plz fix teh loader");
  });
}

test("/polish puts the polished argument text in the empty prompt box", async (t) => {
  const h = harness(t);
  h.type("/polish hey can u check teh deploy");
  await h.press("\r");
  assert.equal(
    h.requests[0].context.messages[0].content[0].text,
    "hey can u check teh deploy",
  );
  assert.equal(h.editor.getExpandedText(), "Polished text.");
});

test("an empty draft or bare /polish asks for text without a request", async (t) => {
  const h = harness(t);
  await h.press(shortcut);
  h.type("/polish");
  await h.press("\r");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(
    h.notices.map((notice) => notice.level),
    ["warning", "warning"],
  );
  assert.match(h.notices[0].message, /press ctrl\+alt\+p/);
});

test("unreadable rules leave the draft alone and name the file", async (t) => {
  const h = harness(t, {
    readRules: () => {
      throw new Error("ENOENT");
    },
  });
  h.type("raw draft");
  await h.press(shortcut);
  assert.equal(h.requests.length, 0);
  assert.equal(h.editor.getExpandedText(), "raw draft");
  assert.match(
    h.notices[0].message,
    /\/rules\/rules\.md\. Set polish\.rulesFile\./,
  );
  assert.equal(h.notices[0].level, "error");
});

for (const [name, response, message] of [
  [
    "a model error",
    () => reply(undefined, "error", "rate limited"),
    /rate limited/,
  ],
  ["a cut-off reply", () => reply("Half a", "length"), /cut off/],
  ["an empty reply", () => reply("  \n"), /no text/],
  [
    "a thrown request",
    () => {
      throw new Error("socket closed");
    },
    /socket closed/,
  ],
]) {
  test(`${name} keeps the draft and reports why`, async (t) => {
    const h = harness(t, { respond: response });
    h.type("raw draft");
    await h.press(shortcut);
    assert.equal(h.editor.getExpandedText(), "raw draft");
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].level, "error");
    assert.match(h.notices[0].message, message);
    assert.match(h.notices[0].message, /The draft is unchanged\./);
  });
}

test("cancelling the loader aborts the request and keeps the draft", async (t) => {
  let signal;
  let finish;
  const h = harness(t, {
    respond: (call) => {
      signal = call.options.signal;
      return new Promise((done) => {
        finish = done;
      });
    },
    onCustom: (loader) => queueMicrotask(() => loader.handleInput("\x1b")),
  });
  h.type("raw draft");
  await h.press(shortcut);
  assert.equal(signal.aborted, true);
  finish(reply("late polished text"));
  await new Promise((done) => setImmediate(done));
  assert.equal(h.editor.getExpandedText(), "raw draft");
  assert.deepEqual(h.notices, [
    { message: "Polish cancelled. The draft is unchanged.", level: "info" },
  ]);
});

test("a second request while one runs is refused", async (t) => {
  let finish;
  const h = harness(t, {
    respond: () =>
      new Promise((done) => {
        finish = done;
      }),
  });
  h.type("raw draft");
  const first = h.press(shortcut);
  await new Promise((done) => setImmediate(done));
  await h.commands.get("polish").handler("another draft", h.ctx);
  assert.equal(h.requests.length, 1);
  assert.match(h.notices[0].message, /already running/);
  finish(reply("Polished text."));
  await first;
  assert.equal(h.editor.getExpandedText(), "Polished text.");
});

test("a configured model is used without reasoning when it has none", async (t) => {
  const h = harness(t, { config: { model: "other/plain-model" } });
  h.type("raw draft");
  await h.press(shortcut);
  assert.equal(h.requests[0].model, otherModel);
  assert.equal(Object.hasOwn(h.requests[0].options, "reasoning"), false);
});

test("an unavailable model or no session model makes no request", async (t) => {
  for (const options of [
    { config: { model: "missing/model" } },
    { model: undefined },
  ]) {
    const h = harness(t, options);
    h.type("raw draft");
    await h.press(shortcut);
    assert.equal(h.requests.length, 0);
    assert.equal(h.editor.getExpandedText(), "raw draft");
    assert.equal(h.notices[0].level, "error");
  }
});

test("polish does nothing outside the interactive TUI", async (t) => {
  const h = harness(t, { mode: "rpc" });
  await h.commands.get("polish").handler("raw draft", h.ctx);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.notices, []);
});

test("polish configuration defaults and validation", (t) => {
  const home = mkdtempSync(join(tmpdir(), "polish-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  const write = (value) => writeFileSync(path, JSON.stringify(value));
  assert.deepEqual(defaults.polish, {
    rulesFile: null,
    shortcut: "ctrl+alt+p",
    model: null,
  });
  write({
    polish: { rulesFile: "rules.md", shortcut: "ctrl+alt+k", model: "a/b-1" },
  });
  assert.deepEqual(readConfig(path).polish, {
    rulesFile: join(home, "rules.md"),
    shortcut: "ctrl+alt+k",
    model: "a/b-1",
  });
  for (const polish of [
    { shortcut: "ctrl+p" },
    { shortcut: "alt+p" },
    { model: "no-provider" },
    { model: "a/" },
    { rulesFile: "" },
  ])
    assert.throws(() => (write({ polish }), readConfig(path)), /polish/);
  write({ voice: { shortcut: "ctrl+alt+p" } });
  assert.throws(() => readConfig(path), /must differ from voice\.shortcut/);
});
