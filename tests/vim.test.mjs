import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(packageDir, "Run with node scripts/test.mjs.");
const require = createRequire(join(packageDir, "package.json"));
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { KeybindingsManager } = await import(
  pathToFileURL(join(packageDir, "dist/core/keybindings.js"))
);
const { setKeybindings, visibleWidth, CURSOR_MARKER } = await import(
  pathToFileURL(require.resolve("@earendil-works/pi-tui"))
);
const source = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/vim/index.ts",
);
const identity = (text) => text;
const theme = {
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
const esc = "\x1b";
const enter = "\r";
const paste = (text) => `\x1b[200~${text}\x1b[201~`;
const tick = () => new Promise((done) => setImmediate(done));

async function harness({
  mode = "tui",
  existing,
  config = {},
  inputHook = true,
} = {}) {
  const loaded = await loadExtensions([source], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const bindings = new KeybindingsManager(config);
  setKeybindings(bindings);
  const inputListeners = new Set([
    (data) =>
      bindings.matches(data, "tui.altScreen.pageUp")
        ? { consume: true }
        : undefined,
  ]);
  const tui = {
    terminal: { rows: 30, columns: 80 },
    requestRender() {},
    ...(inputHook ? { inputListeners } : {}),
    addInputListener(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },
  };
  let factory = existing;
  const notices = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (value) => {
        factory = value;
      },
      notify: (message, level) => notices.push({ message, level }),
      onTerminalInput: (listener) => tui.addInputListener(listener),
    },
  };
  async function start() {
    for (const handler of loaded.extensions[0].handlers.get("session_start")) {
      await handler({ type: "session_start" }, ctx);
    }
  }
  await start();
  const create = () => factory?.(tui, theme, bindings);
  const editor = existing ? undefined : create();
  return {
    editor,
    create,
    notices,
    start,
    ctx,
    inputListeners,
    input(data, view = editor) {
      for (const listener of inputListeners) {
        if (listener(data)?.consume) return;
      }
      view.handleInput(data);
    },
    async shutdown() {
      for (const handler of loaded.extensions[0].handlers.get(
        "session_shutdown",
      ) ?? []) {
        await handler({ type: "session_shutdown" }, ctx);
      }
    },
  };
}

function keys(editor, text) {
  for (const key of text) editor.handleInput(key);
}
function mode(editor) {
  return editor
    .render(80)
    .find((line) => / (INSERT|NORMAL) $/.test(line))
    ?.trim();
}
function assertMode(editor, expected) {
  assert.ok(mode(editor)?.endsWith(expected), mode(editor));
}
function normalAt(editor, lines, line = 0, col = 0) {
  editor.setText(lines.join("\n"));
  editor.handleInput(esc);
  editor.handleInput("0");
  for (let i = lines.length - 1; i > line; i--) editor.handleInput("k");
  editor.handleInput("0");
  while (editor.getCursor().col < col) {
    const before = editor.getCursor().col;
    editor.handleInput("l");
    assert.ok(editor.getCursor().col > before, `Cannot reach column ${col}`);
  }
  assert.deepEqual(editor.getCursor(), { line, col });
}

const completion = {
  async getSuggestions() {
    return {
      prefix: "/",
      items: [
        { value: "/fixture", label: "fixture" },
        { value: "/other", label: "other" },
      ],
    };
  },
  applyCompletion() {
    return { lines: ["/fixture "], cursorLine: 0, cursorCol: 9 };
  },
};

const unicodeFixtures = [
  "foo₂bar",
  "foo⁴bar",
  "foo²bar",
  "foo×bar",
  "foo🙂!bar",
  "foo你好bar",
  "fooあいうbar",
  "fooカナbar",
  "foo한글bar",
  "你好世界",
  "foo⌘bar",
].map((text) => [text]);

function neovim(cases) {
  const output = [];
  // Keep each environment value comfortably below the OS argument-size limit.
  for (let start = 0; start < cases.length; start += 100) {
    const batch = cases.slice(start, start + 100).map((item) => ({
      ...item,
      bytecol: Buffer.byteLength(item.lines[item.line].slice(0, item.col)),
      keys: item.keys ?? item.key,
    }));
    const lua = `
      local out = {}
      for _, c in ipairs(vim.json.decode(vim.env.PI_VIM_CASES)) do
        vim.cmd('enew!')
        vim.api.nvim_buf_set_lines(0, 0, -1, false, c.lines)
        vim.api.nvim_win_set_cursor(0, {c.line + 1, c.bytecol})
        for _, k in ipairs(type(c.keys) == 'table' and c.keys or {c.keys}) do
          vim.cmd('normal! ' .. k)
        end
        table.insert(out, {lines=vim.api.nvim_buf_get_lines(0,0,-1,false), cursor=vim.api.nvim_win_get_cursor(0)})
      end
      io.stdout:write(vim.json.encode(out))
    `;
    const reference = spawnSync(
      "nvim",
      [
        "--clean",
        "-u",
        "NONE",
        "-i",
        "NONE",
        "--headless",
        "-n",
        "-c",
        `lua ${lua}`,
        "-c",
        "qa!",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, PI_VIM_CASES: JSON.stringify(batch) },
      },
    );
    assert.equal(reference.status, 0, reference.stderr);
    output.push(...JSON.parse(reference.stdout));
  }
  return output;
}

test("real loader installs only in TUI mode and does not replace another editor", async () => {
  const h = await harness();
  assert.equal(h.editor.supported, true);
  assertMode(h.editor, "INSERT");
  await h.start();
  assertMode(h.create(), "INSERT");
  assert.deepEqual(h.notices, []);
  for (const mode of ["print", "rpc", "json"]) {
    const headless = await harness({ mode });
    assert.equal(headless.editor, undefined);
    assert.deepEqual(headless.notices, []);
  }
  const occupied = await harness({
    existing: () => assert.fail("Do not replace"),
  });
  assert.equal(occupied.notices.length, 1);
  assert.match(occupied.notices[0].message, /another extension/);
});

test("INSERT types normally, Escape moves left, and NORMAL ignores unsupported text", async () => {
  const { editor } = await harness();
  keys(editor, "hello");
  assert.equal(editor.getText(), "hello");
  editor.handleInput(esc);
  assertMode(editor, "NORMAL");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  keys(editor, "dcpv:1239");
  editor.handleInput("Ä");
  editor.handleInput("你好");
  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
});

test("h/l and 0/$ stay on characters and never cross a line", async () => {
  const { editor } = await harness();
  normalAt(editor, ["abc", "def"]);
  editor.handleInput("h");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  keys(editor, "lllll");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  keys(editor, "0$");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  normalAt(editor, ["", "def"]);
  keys(editor, "hl0$x");
  assert.equal(editor.getText(), "\ndef");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("j/k use logical lines, keep a preferred display column and never browse history", async () => {
  const { editor } = await harness();
  editor.addToHistory("older prompt");
  normalAt(editor, ["abcdef", "x", "", "abcdef"], 0, 4);
  keys(editor, "jjj");
  assert.deepEqual(editor.getCursor(), { line: 3, col: 4 });
  keys(editor, "kkkk");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  assert.equal(editor.getText(), "abcdef\nx\n\nabcdef");
  editor.handleInput("h");
  keys(editor, "jjj");
  assert.deepEqual(editor.getCursor(), { line: 3, col: 3 });
  normalAt(editor, ["a".repeat(150), "second"]);
  editor.render(20);
  editor.handleInput("j");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  normalAt(editor, ["ab", "longer", "x"]);
  keys(editor, "$j");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 5 });
  keys(editor, "jk");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 5 });
});

test("i/a/I/A enter INSERT at their Vim positions", async () => {
  const { editor } = await harness();
  for (const [key, col, expected] of [
    ["i", 3, "  aXbc"],
    ["a", 3, "  abXc"],
    ["I", 3, "  Xabc"],
    ["A", 3, "  abcX"],
  ]) {
    normalAt(editor, ["  abc"], 0, col);
    keys(editor, `${key}X`);
    assertMode(editor, "INSERT");
    assert.equal(editor.getText(), expected, key);
  }
  normalAt(editor, [""]);
  keys(editor, "aX");
  assert.equal(editor.getText(), "X");
  normalAt(editor, ["   "]);
  keys(editor, "IX");
  assert.equal(editor.getText(), "  X ");
});

test("w/b/e separate punctuation, cross lines and handle blank lines", async () => {
  const { editor } = await harness();
  normalAt(editor, ["foo.bar  baz", "next", "", "last"]);
  const expected = [
    [0, 3],
    [0, 4],
    [0, 9],
    [1, 0],
    [2, 0],
    [3, 0],
    [3, 3],
  ];
  for (const [line, col] of expected) {
    editor.handleInput("w");
    assert.deepEqual(editor.getCursor(), { line, col });
  }
  editor.handleInput("b");
  assert.deepEqual(editor.getCursor(), { line: 3, col: 0 });
  editor.handleInput("b");
  assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
  normalAt(editor, ["foo.bar  baz"]);
  for (const col of [2, 3, 6, 11]) {
    editor.handleInput("e");
    assert.deepEqual(editor.getCursor(), { line: 0, col });
  }
});

test("graphemes stay whole for motion, insertion, deletion and undo", async () => {
  const { editor } = await harness();
  const family = "👨‍👩‍👧‍👦";
  normalAt(editor, [`a${family}e\u0301z`], 0, 1);
  editor.handleInput("l");
  assert.equal(editor.getCursor().col, 1 + family.length);
  editor.handleInput("x");
  assert.equal(editor.getText(), `a${family}z`);
  editor.handleInput("u");
  assert.equal(editor.getText(), `a${family}e\u0301z`);
  normalAt(editor, [`a${family}z`], 0, 1);
  keys(editor, "aX");
  assert.equal(editor.getText(), `a${family}Xz`);
  normalAt(editor, ["界ab", "abcd"], 0, 1);
  editor.handleInput("j");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
});

test("x never joins lines and u restores native edits without Vim-specific grouping", async () => {
  const { editor } = await harness();
  normalAt(editor, ["ab", "cd"], 0, 1);
  editor.handleInput("x");
  assert.equal(editor.getText(), "a\ncd");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  editor.handleInput("u");
  assert.equal(editor.getText(), "ab\ncd");
  editor.setText("");
  keys(editor, "hello world");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "hello");
  editor.handleInput("u");
  assert.equal(editor.getText(), "");
  assertMode(editor, "NORMAL");
});

test("text pastes are literal in both modes, including fragmented pastes and Escape", async () => {
  const { editor } = await harness();
  const submissions = [];
  editor.onSubmit = (text) => submissions.push(text);
  editor.handleInput(paste("hello\nworld"));
  assert.equal(editor.getText(), "hello\nworld");
  assertMode(editor, "INSERT");
  normalAt(editor, ["ab"]);
  editor.handleInput("\x1b[200~xuih");
  editor.handleInput("\x1b");
  editor.handleInput("\nA\x1b[201~");
  assert.equal(editor.getText(), "xuih\nAab");
  assertMode(editor, "NORMAL");
  assert.deepEqual(submissions, []);
  normalAt(editor, ["ab"]);
  editor.handleInput(`${paste("literal")}l`);
  assert.equal(editor.getText(), "literalab");
  assert.equal(editor.getCursor().col, 8);
});

test("collapsed paste markers are atomic and their expanded content survives undo", async () => {
  const { editor } = await harness();
  const content = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  editor.handleInput(paste(content));
  assert.match(editor.getText(), /^\[paste #1 /);
  assert.equal(editor.getExpandedText(), content);
  editor.handleInput(esc);
  assert.equal(editor.getCursor().col, 0);
  keys(editor, "hle");
  assert.equal(editor.getCursor().col, 0);
  editor.handleInput("x");
  assert.equal(editor.getText(), "");
  editor.handleInput("u");
  assert.equal(editor.getExpandedText(), content);
  assert.equal(editor.getCursor().col, 0);
  keys(editor, "a!");
  assert.equal(editor.getExpandedText(), `${content}!`);
});

test("Escape closes completion before changing modes or interrupting", async () => {
  const { editor } = await harness();
  let interrupts = 0;
  editor.onEscape = () => interrupts++;
  editor.setAutocompleteProvider(completion);
  editor.handleInput("/");
  await tick();
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput(esc);
  assert.equal(editor.isShowingAutocomplete(), false);
  assertMode(editor, "INSERT");
  editor.handleInput(esc);
  assertMode(editor, "NORMAL");
  assert.equal(interrupts, 0);
  editor.handleInput(esc);
  assert.equal(interrupts, 1);
  editor.handleInput("\t");
  await tick();
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput(esc);
  assert.equal(interrupts, 1);
  assert.equal(editor.isShowingAutocomplete(), false);
});

test("submission resets to INSERT, disabled submission and completion do not", async () => {
  const { editor } = await harness();
  const submissions = [];
  editor.onSubmit = (text) => submissions.push(text);
  normalAt(editor, ["hello"]);
  editor.disableSubmit = true;
  editor.handleInput(enter);
  assertMode(editor, "NORMAL");
  assert.equal(editor.getText(), "hello");
  editor.disableSubmit = false;
  editor.handleInput(enter);
  assert.deepEqual(submissions, ["hello"]);
  assertMode(editor, "INSERT");
  assert.equal(editor.getText(), "");
  normalAt(editor, ["/"]);
  editor.setAutocompleteProvider(completion);
  editor.handleInput("\t");
  await tick();
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/fixture ");
  assertMode(editor, "NORMAL");
  editor.handleInput(enter);
  assert.deepEqual(submissions, ["hello", "/fixture"]);
  assertMode(editor, "INSERT");
});

test("Pi shortcuts, remapped bindings, history and image paste remain available", async () => {
  const { editor } = await harness({
    config: {
      "app.editor.external": "ctrl+e",
      "tui.editor.cursorLeft": "ctrl+q",
      "tui.editor.undo": "ctrl+u",
    },
  });
  let external = 0;
  let images = 0;
  let extensionShortcuts = 0;
  editor.onAction("app.editor.external", () => external++);
  editor.onAction("app.clear", () => editor.setText(""));
  editor.onPasteImage = () => images++;
  editor.onExtensionShortcut = (data) => {
    if (data !== "\x1b[24~") return false;
    extensionShortcuts++;
    return true;
  };
  normalAt(editor, ["hello"], 0, 2);
  editor.handleInput("\x05");
  editor.handleInput("\x16");
  editor.handleInput("\x1b[24~");
  assert.equal(external, 1);
  assert.equal(images, 1);
  assert.equal(extensionShortcuts, 1);
  editor.handleInput("h");
  assert.equal(editor.getCursor().col, 1);
  editor.handleInput("\x11");
  assert.equal(editor.getCursor().col, 0);
  keys(editor, "xu");
  assert.equal(editor.getText(), "hello");
  editor.addToHistory("older prompt");
  editor.handleInput("0");
  editor.handleInput("\x1b[A");
  assert.equal(editor.getText(), "older prompt");
  editor.handleInput("\x03");
  assert.equal(editor.getText(), "");
  assertMode(editor, "INSERT");
});

test("Kitty-encoded Vim keys work, including shifted I/A and Escape", async () => {
  const { editor } = await harness();
  normalAt(editor, ["hello"], 0, 3);
  editor.handleInput("\x1b[104u");
  assert.equal(editor.getCursor().col, 2);
  editor.handleInput("\x1b[105:73;2u");
  assertMode(editor, "INSERT");
  assert.equal(editor.getCursor().col, 0);
  editor.handleInput("\x1b[27u");
  assertMode(editor, "NORMAL");
  editor.handleInput("\x1b[97:65;2u");
  assertMode(editor, "INSERT");
  assert.equal(editor.getCursor().col, 5);
});

test("Kitty uses actual text rather than a non-Latin key's physical layout", async () => {
  const { editor } = await harness();
  normalAt(editor, ["hello"], 0, 2);
  editor.handleInput("\x1b[1095::120u"); // Cyrillic ч on the physical x key.
  editor.handleInput("\x1b[1095:1063:120;2u");
  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  editor.handleInput("\x1b[36;2u"); // Shifted $ without an alternate codepoint.
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  assert.equal(editor.getText(), "hello");
});

test("native rendering keeps focus markers, working status and narrow-width bounds", async () => {
  const { editor } = await harness();
  editor.setText("界👨‍👩‍👧‍👦e\u0301".repeat(5));
  editor.focused = true;
  editor.setWorkingStatusIndicator({
    renderInBorder: () => "Working",
    renderSpinnerInBorder: () => "W",
  });
  assert.match(editor.render(80)[0], /Working/);
  assert.ok(editor.render(80).join("\n").includes(CURSOR_MARKER));
  // Pi itself cannot wrap a wide grapheme into a single-column text area.
  for (const width of [5, 10, 20, 80]) {
    for (const line of editor.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}`,
      );
    }
  }
  editor.handleInput(esc);
  assertMode(editor, "NORMAL");
  editor.focused = false;
  editor.invalidate();
  assert.ok(!editor.render(80).join("\n").includes(CURSOR_MARKER));
  editor.setText("new draft");
  assertMode(editor, "INSERT");
});

test("keypad Enter submits and Shift+Enter keeps Pi's newline behavior", async () => {
  const { editor } = await harness();
  const submissions = [];
  editor.onSubmit = (text) => submissions.push(text);
  normalAt(editor, ["hello"]);
  editor.handleInput("\x1b[57414u");
  assert.deepEqual(submissions, ["hello"]);
  assertMode(editor, "INSERT");
  normalAt(editor, ["hello"], 0, 2);
  editor.handleInput("\x1b[57414;2u");
  assert.equal(editor.getText(), "he\nllo");
  assert.deepEqual(submissions, ["hello"]);
  assertMode(editor, "NORMAL");
});

test("modifyOtherKeys uses Vim commands, not accidental text insertion", async () => {
  const { editor } = await harness();
  normalAt(editor, ["  hello"], 0, 4);
  editor.handleInput("\x1b[27;1;104~");
  assert.equal(editor.getCursor().col, 3);
  editor.handleInput("\x1b[27;2;36~");
  assert.equal(editor.getCursor().col, 6);
  for (const data of [
    "\x1b[27;2;86~",
    "\x1b[27;1;196~",
    "\x1b[32u",
    "\x1b[32;2u",
    "\x1b[196u",
  ])
    editor.handleInput(data);
  assert.equal(editor.getText(), "  hello");
  assertMode(editor, "NORMAL");
  editor.handleInput("\x1b[27;2;73~");
  assertMode(editor, "INSERT");
  editor.handleInput("X");
  assert.equal(editor.getText(), "  Xhello");
  normalAt(editor, ["  hello"], 0, 4);
  editor.handleInput("\x1b[27;1;73~"); // Uppercase text without a Shift modifier.
  assertMode(editor, "INSERT");
  assert.equal(editor.getCursor().col, 2);
});

test("Escape cancels pending native jumps and NORMAL preserves jump shortcuts", async () => {
  const { editor } = await harness();
  keys(editor, "hello");
  editor.handleInput("\x1d");
  editor.handleInput(esc);
  keys(editor, "iX");
  assert.equal(editor.getText(), "hellXo");
  normalAt(editor, ["a h z"]);
  editor.handleInput("\x1d");
  editor.handleInput("h");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  assert.equal(editor.getText(), "a h z");
  assertMode(editor, "NORMAL");
});

test("unsupported editor shapes leave ordinary Pi typing available", async () => {
  const { createJiti } = require("jiti");
  const { editorPort } = await createJiti(import.meta.url).import(
    join(dirname(source), "editor-port.ts"),
  );
  assert.equal(editorPort({}), undefined);
  const { editor } = await harness();
  assert.ok(editorPort(editor));
  // Simulate the adapter declining a future upstream editor shape.
  editor.port = editorPort({});
  assert.equal(editor.supported, false);
  keys(editor, "hello");
  assert.equal(editor.getText(), "hello");
  editor.handleInput(esc);
  editor.handleInput("x");
  assert.equal(editor.getText(), "hellox");
});

test("package manifest declares the Vim entrypoint and it loads standalone outside the package", async (t) => {
  const root = resolve(dirname(source), "../..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/vim/index.ts"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-vim-package-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const loaded = await loadExtensions([source], cwd);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("session_start"));
});

test("c/d wait for a motion, show it in the border, and Escape cancels without interrupting", async () => {
  const { editor } = await harness();
  let interrupts = 0;
  editor.onEscape = () => interrupts++;
  for (const operator of ["c", "d"]) {
    const before = interrupts;
    normalAt(editor, ["alpha beta"]);
    editor.handleInput(operator);
    assert.equal(editor.getText(), "alpha beta");
    assert.match(
      editor.render(80).join("\n"),
      new RegExp(`${operator} · NORMAL`),
    );
    editor.handleInput(esc);
    assert.equal(interrupts, before);
    assert.ok(!editor.render(80).join("\n").includes(`${operator} · NORMAL`));
    assertMode(editor, "NORMAL");
    editor.handleInput(esc);
    assert.equal(interrupts, operator === "c" ? 1 : 2);
  }
});

test("unsupported operator suffixes and native shortcuts cancel instead of deleting", async () => {
  const { editor } = await harness();
  for (const command of ["cj", "dk", "ci", "da", "dx", "cd", "dc"]) {
    normalAt(editor, ["alpha beta"]);
    keys(editor, command);
    assert.equal(editor.getText(), "alpha beta", command);
    assertMode(editor, "NORMAL");
    assert.ok(!editor.render(80).join("\n").includes(" · NORMAL"));
  }
  normalAt(editor, ["alpha beta"]);
  keys(editor, "d");
  editor.handleInput("\x06"); // Native right arrow action cancels pending d.
  editor.handleInput("w");
  assert.equal(editor.getText(), "alpha beta");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
  editor.handleInput("d");
  editor.handleInput(paste("cw dd"));
  assert.equal(editor.getText(), "alpha cw ddbeta");
});

test("viewport-owned keys cancel pending operators before consuming input, without leaking listeners", async () => {
  const h = await harness();
  h.editor.focused = true;
  // A renderer switch rebinds Pi's registered observers after viewport input.
  h.inputListeners.delete(h.editor.inputListener);
  h.inputListeners.add(h.editor.inputListener);
  normalAt(h.editor, ["alpha beta"]);
  h.input("d");
  h.input("\x1b[5~"); // The fake viewport consumes PageUp before editor dispatch.
  h.input("w");
  assert.equal(h.editor.getText(), "alpha beta");
  assert.deepEqual(h.editor.getCursor(), { line: 0, col: 6 });
  h.input("d");
  h.input(esc);
  assertMode(h.editor, "NORMAL");
  assert.ok(!h.editor.render(80).join("\n").includes("d · NORMAL"));
  assert.equal(h.inputListeners.size, 2);
  await h.start();
  h.create();
  assert.equal(h.inputListeners.size, 2);
  await h.shutdown();
  assert.equal(h.inputListeners.size, 1);
  const unsupported = await harness({ inputHook: false });
  assert.match(unsupported.notices[0].message, /unsupported/);
  keys(unsupported.editor, "hello");
  assert.equal(unsupported.editor.getText(), "hello");
});

test("Kitty Backspace cancels a pending operator and performs native deletion", async () => {
  const { editor } = await harness();
  normalAt(editor, ["abc"], 0, 1);
  editor.handleInput("d");
  editor.handleInput("\x1b[127u");
  assert.equal(editor.getText(), "bc");
  assertMode(editor, "NORMAL");
  assert.ok(!editor.render(80).join("\n").includes("d · NORMAL"));
});

test("f/F/t/T wait for a character, show it in the border and cancel like operators", async () => {
  const h = await harness();
  const { editor } = h;
  let interrupts = 0;
  editor.onEscape = () => interrupts++;
  normalAt(editor, ["a c d f ; ,"]);
  keys(editor, ";,");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  for (const prefix of ["f", "dt", "cF"]) {
    keys(editor, prefix);
    assert.match(
      editor.render(80).join("\n"),
      new RegExp(`${prefix} · NORMAL`),
    );
    editor.handleInput(esc);
    assert.equal(interrupts, 0);
    assertMode(editor, "NORMAL");
    assert.ok(!editor.render(80).join("\n").includes(" · NORMAL"));
  }
  // The key after f is always the target, even when it is a command.
  for (const [command, col] of [
    ["fc", 2],
    ["fd", 4],
    ["ff", 6],
    ["f;", 8],
    ["f,", 10],
  ]) {
    normalAt(editor, ["a c d f ; ,"]);
    keys(editor, command);
    assert.deepEqual(editor.getCursor(), { line: 0, col }, command);
    assert.equal(editor.getText(), "a c d f ; ,");
  }
  // Searches stay on the line.
  normalAt(editor, ["ab", "cd"]);
  keys(editor, "fc");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  // Native shortcuts cancel the pending search and keep their action.
  normalAt(editor, ["alpha beta"]);
  editor.handleInput("f");
  editor.handleInput("\x06");
  editor.handleInput("b");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  // Viewport keys cancel it before the viewport consumes them.
  editor.focused = true;
  normalAt(editor, ["alpha beta"]);
  h.input("d");
  h.input("t");
  h.input("\x1b[5~");
  h.input("a");
  assert.equal(editor.getText(), "alpha beta");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
});

test("f/t keep characters and paste markers whole, and dt./ct. undo as one step", async () => {
  const { editor } = await harness();
  const content = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  editor.handleInput(paste(content));
  keys(editor, " #.");
  const marker = editor.getText().lastIndexOf(" #");
  editor.handleInput(esc);
  editor.handleInput("0");
  keys(editor, "f#");
  assert.equal(editor.getCursor().col, marker + 1);
  keys(editor, "F[");
  assert.equal(editor.getCursor().col, 0);
  keys(editor, "dt.");
  assert.equal(editor.getText(), ".");
  editor.handleInput("u");
  assert.equal(editor.getExpandedText(), `${content} #.`);
  // Vim's Te stops inside a decomposed é. Pi keeps the character whole.
  normalAt(editor, ["e\u0301xe\u0301x"], 0, 5);
  keys(editor, "Fe");
  assert.equal(editor.getCursor().col, 3);
  keys(editor, "$Te");
  assert.equal(editor.getCursor().col, 5);
  keys(editor, "dTe");
  assert.equal(editor.getText(), "e\u0301xe\u0301x");
  normalAt(editor, ["one.two"]);
  keys(editor, "ct.ab");
  editor.handleInput(esc);
  assert.equal(editor.getText(), "ab.two");
  editor.handleInput("u");
  assert.equal(editor.getText(), "one.two");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "ab.two");
});

test("counts show in the border, keep 0 as a motion until they start, and repeat undo and redo", async () => {
  const { editor } = await harness();
  let interrupts = 0;
  editor.onEscape = () => interrupts++;
  normalAt(editor, ["a b c d e f g h i j k l"]);
  for (const prefix of ["10", "2d3", "3f"]) {
    keys(editor, prefix);
    assert.match(
      editor.render(80).join("\n"),
      new RegExp(`${prefix} · NORMAL`),
    );
    editor.handleInput(esc);
    assert.equal(interrupts, 0);
    assert.ok(!editor.render(80).join("\n").includes(" · NORMAL"));
  }
  keys(editor, "10w");
  assert.equal(editor.getCursor().col, 20);
  keys(editor, "0");
  assert.equal(editor.getCursor().col, 0);
  keys(editor, "2d3w");
  assert.equal(editor.getText(), "g h i j k l");
  // Counts on insertion are ignored rather than repeating the text.
  keys(editor, "3iX");
  editor.handleInput(esc);
  assert.equal(editor.getText(), "Xg h i j k l");
  normalAt(editor, ["abcdef"]);
  keys(editor, "xxxx");
  assert.equal(editor.getText(), "ef");
  keys(editor, "3u");
  assert.equal(editor.getText(), "bcdef");
  editor.handleInput("2");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "def");
  keys(editor, "3u");
  assert.equal(editor.getText(), "abcdef");
  // Huge counts stop at the ends of the prompt instead of looping.
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  normalAt(editor, [text]);
  const started = performance.now();
  keys(editor, "99999999999w");
  keys(editor, "99999999999b");
  keys(editor, "99999999999x");
  assert.equal(editor.getText(), "");
  assert.ok(performance.now() - started < 1000);
});

test("word changes keep trailing spaces and deletion consumes them", async () => {
  const { editor } = await harness();
  normalAt(editor, ["alpha beta"], 0, 4);
  keys(editor, "cw");
  assertMode(editor, "INSERT");
  assert.equal(editor.getText(), "alph beta");
  keys(editor, "NEW WORD");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "alpha beta");
  normalAt(editor, ["alpha beta"], 0, 4);
  keys(editor, "dw");
  assertMode(editor, "NORMAL");
  assert.equal(editor.getText(), "alphbeta");
  editor.handleInput("u");
  assert.equal(editor.getText(), "alpha beta");
});

test("every change operator groups deletion and all replacement text into one undo", async () => {
  const { editor } = await harness();
  for (const command of ["cw", "ce", "cb", "c0", "c$", "cc", "C"]) {
    const before = "  alpha beta";
    normalAt(editor, [before], 0, 4);
    keys(editor, command);
    assertMode(editor, "INSERT");
    keys(editor, "new text");
    editor.handleInput(paste("\nand a paste"));
    editor.handleInput(esc);
    assertMode(editor, "NORMAL");
    editor.handleInput("u");
    assert.equal(editor.getText(), before, command);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 }, command);
  }
  normalAt(editor, ["alpha beta"]);
  keys(editor, "c0new text");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "alpha beta");
});

test("consecutive changes and deletions remain separate undo units", async () => {
  const { editor } = await harness();
  normalAt(editor, ["alpha beta"]);
  keys(editor, "cwone");
  editor.handleInput(esc);
  keys(editor, "wcwtwo");
  editor.handleInput(esc);
  assert.equal(editor.getText(), "one two");
  editor.handleInput("u");
  assert.equal(editor.getText(), "one beta");
  editor.handleInput("u");
  assert.equal(editor.getText(), "alpha beta");
  normalAt(editor, ["one two three"]);
  keys(editor, "dwdw");
  assert.equal(editor.getText(), "three");
  editor.handleInput("u");
  assert.equal(editor.getText(), "two three");
  editor.handleInput("u");
  assert.equal(editor.getText(), "one two three");
});

test("cc keeps indentation, dd removes the line, and aliases stop at line end", async () => {
  const { editor } = await harness();
  normalAt(editor, ["before", "  alpha", "after"], 1, 4);
  keys(editor, "ccNEW");
  assert.equal(editor.getText(), "before\n  NEW\nafter");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "before\n  alpha\nafter");
  keys(editor, "dd");
  assert.equal(editor.getText(), "before\nafter");
  assertMode(editor, "NORMAL");
  editor.handleInput("u");
  assert.equal(editor.getText(), "before\n  alpha\nafter");
  for (const command of ["D", "d$"]) {
    normalAt(editor, ["alpha beta", "next"], 0, 6);
    keys(editor, command);
    assert.equal(editor.getText(), "alpha \nnext");
  }
  normalAt(editor, [""]);
  keys(editor, "dd");
  assert.equal(editor.getText(), "");
  assertMode(editor, "NORMAL");
  keys(editor, "ccNEW");
  assert.equal(editor.getText(), "NEW");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "");
});

test("native undo, completion and submission do not leave stale change groups", async () => {
  const { editor } = await harness();
  normalAt(editor, ["alpha beta"]);
  keys(editor, "cwnew text");
  editor.handleInput("\x1f");
  assert.equal(editor.getText(), "alpha beta");
  keys(editor, "X");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "alpha beta");
  normalAt(editor, ["old"]);
  keys(editor, "cc");
  editor.setAutocompleteProvider(completion);
  editor.handleInput("/");
  await tick();
  editor.handleInput("\t");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "old");
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);
  normalAt(editor, ["old"]);
  keys(editor, "ccnew");
  editor.handleInput(enter);
  assert.deepEqual(submitted, ["new"]);
  assertMode(editor, "INSERT");
  keys(editor, "fresh");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), "");
});

test("operators preserve graphemes and undo restores complete collapsed pastes", async () => {
  const { editor } = await harness();
  const family = "👨‍👩‍👧‍👦";
  normalAt(editor, [`a${family}e\u0301 tail`], 0, 1);
  keys(editor, "cwX");
  assert.equal(editor.getText(), "aXe\u0301 tail");
  editor.handleInput(esc);
  editor.handleInput("u");
  assert.equal(editor.getText(), `a${family}e\u0301 tail`);
  const content = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  for (const command of ["cw", "dw", "cc", "dd", "ce", "de"]) {
    editor.setText("");
    editor.handleInput(paste(content));
    keys(editor, " tail");
    editor.handleInput(esc);
    editor.handleInput("0");
    keys(editor, command);
    if (command.startsWith("c")) {
      keys(editor, "new text");
      editor.handleInput(esc);
    }
    editor.handleInput("u");
    assert.equal(editor.getExpandedText(), `${content} tail`, command);
  }
});

test("Ctrl+R redoes successive deletions and undo can traverse them again", async () => {
  const { editor } = await harness();
  normalAt(editor, ["one two three"]);
  keys(editor, "dwdwuu");
  assert.equal(editor.getText(), "one two three");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "two three");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "three");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "three");
  keys(editor, "uu");
  assert.equal(editor.getText(), "one two three");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "two three");
  assertMode(editor, "NORMAL");
});

test("Ctrl+R restores each change and its replacement as one complete snapshot", async () => {
  const { editor } = await harness();
  for (const command of ["cw", "ce", "cb", "c0", "c$", "cc", "C"]) {
    normalAt(editor, ["  alpha beta"], 0, 4);
    keys(editor, `${command}new text`);
    editor.handleInput(paste("\nand a paste"));
    editor.handleInput(esc);
    const text = editor.getText();
    const cursor = editor.getCursor();
    editor.handleInput("u");
    assert.equal(editor.getText(), "  alpha beta", command);
    editor.handleInput("\x12");
    assert.equal(editor.getText(), text, command);
    assert.deepEqual(editor.getCursor(), cursor, command);
    editor.handleInput("u");
    assert.equal(editor.getText(), "  alpha beta", command);
  }
});

test("empty redo is inert, motions keep redo, and r does not trigger it", async () => {
  const { editor } = await harness();
  normalAt(editor, ["abc def"]);
  let changes = 0;
  editor.onChange = () => changes++;
  editor.handleInput("\x12");
  assert.equal(changes, 0);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  // Mode switches without typing are not edits.
  keys(editor, "xuw0$hlbi");
  editor.handleInput(esc);
  editor.handleInput("r");
  assert.equal(editor.getText(), "abc def");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "bc def");
});

test("new native or Vim edits discard redo, including same-text programmatic resets", async () => {
  const { editor } = await harness();
  const edits = [
    () => keys(editor, "lx"),
    () => keys(editor, "dw"),
    () => {
      keys(editor, "cwNEW");
      editor.handleInput(esc);
    },
    () => {
      keys(editor, "iZ");
      editor.handleInput(esc);
    },
    () => editor.handleInput(paste("Z")),
    () => editor.insertTextAtCursor("Z"),
    () => {
      editor.setText(editor.getText());
      editor.handleInput(esc);
    },
    () => {
      editor.setText("another draft");
      editor.handleInput(esc);
    },
  ];
  for (const edit of edits) {
    normalAt(editor, ["abc def"]);
    keys(editor, "xu");
    edit();
    const after = editor.getText();
    editor.handleInput("\x12");
    assert.equal(editor.getText(), after);
  }
  normalAt(editor, ["abc def"]);
  keys(editor, "xu");
  editor.addToHistory("older prompt");
  editor.handleInput("\x1b[A");
  const recalled = editor.getText();
  editor.handleInput("\x12");
  assert.equal(editor.getText(), recalled);
});

test("native undo feeds redo without changing Insert-mode Ctrl+R shortcuts", async () => {
  const { editor } = await harness({
    config: {
      "tui.editor.undo": "ctrl+u",
      "app.model.select": "ctrl+r",
    },
  });
  let selections = 0;
  editor.onAction("app.model.select", () => selections++);
  keys(editor, "hello world");
  editor.handleInput("\x15");
  assert.equal(editor.getText(), "hello");
  editor.handleInput("\x12");
  assert.equal(selections, 1);
  assert.equal(editor.getText(), "hello");
  editor.handleInput(esc);
  editor.handleInput("\x12");
  assert.equal(selections, 1);
  assert.equal(editor.getText(), "hello world");
  editor.handleInput("\x15");
  assert.equal(editor.getText(), "hello");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "hello world");
});

test("redo handles terminal encodings and cancels pending operators", async () => {
  const h = await harness();
  h.editor.focused = true;
  for (const redo of ["\x12", "\x1b[114;5u", "\x1b[27;5;114~"]) {
    normalAt(h.editor, ["abc"]);
    keys(h.editor, "xu");
    h.input("d");
    h.input(redo);
    assert.equal(h.editor.getText(), "bc");
    assertMode(h.editor, "NORMAL");
    assert.ok(!h.editor.render(80).join("\n").includes("d · NORMAL"));
  }
});

test("redo restores graphemes, collapsed-paste contents and paste counters", async () => {
  const { editor } = await harness();
  const first = Array.from({ length: 15 }, (_, i) => `first ${i}`).join("\n");
  const second = Array.from({ length: 16 }, (_, i) => `second ${i}`).join("\n");
  editor.handleInput(paste(first));
  editor.handleInput(esc);
  keys(editor, "ddu");
  assert.equal(editor.getExpandedText(), first);
  editor.handleInput("\x12");
  assert.equal(editor.getExpandedText(), "");
  editor.handleInput("u");
  keys(editor, "A");
  editor.handleInput(paste(second));
  editor.handleInput(esc);
  assert.match(editor.getText(), /paste #2 /);
  const both = editor.getExpandedText();
  assert.equal(both, first + second);
  editor.handleInput("u");
  assert.equal(editor.getExpandedText(), first);
  editor.handleInput("\x12");
  assert.equal(editor.getExpandedText(), both);
  normalAt(editor, ["a👨‍👩‍👧‍👦e\u0301z"], 0, 1);
  keys(editor, "xu");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "ae\u0301z");
});

test("async completion, submission, clear and editor recreation reset redo", async () => {
  const h = await harness();
  const { editor } = h;
  normalAt(editor, ["abc def"]);
  keys(editor, "xu");
  editor.setAutocompleteProvider(completion);
  editor.handleInput("\t");
  await tick();
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/fixture ");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "/fixture ");
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);
  normalAt(editor, ["abc"]);
  keys(editor, "xu");
  editor.handleInput(enter);
  assert.deepEqual(submitted, ["abc"]);
  editor.handleInput(esc);
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "");
  editor.onAction("app.clear", () => editor.setText(""));
  normalAt(editor, ["abc"]);
  keys(editor, "xu");
  editor.handleInput("\x03");
  editor.handleInput(esc);
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "");
  await h.start();
  const fresh = h.create();
  fresh.handleInput(esc);
  fresh.handleInput("\x12");
  assert.equal(fresh.getText(), "");
});

test("adapter installation is idempotent and callback edits invalidate redo", async () => {
  const h = await harness();
  const { editor } = h;
  const { createJiti } = require("jiti");
  const { editorPort } = await createJiti(import.meta.url).import(
    join(dirname(source), "editor-port.ts"),
  );
  assert.equal(editorPort(editor), editor.port);
  normalAt(editor, ["abc def"]);
  keys(editor, "x");
  let mutate = true;
  editor.onChange = () => {
    if (mutate) {
      mutate = false;
      editor.insertTextAtCursor("Z");
    }
  };
  editor.handleInput("u");
  const afterUndoCallback = editor.getText();
  editor.handleInput("\x12");
  assert.equal(editor.getText(), afterUndoCallback);
  editor.onChange = undefined;
  normalAt(editor, ["one two three"]);
  keys(editor, "dwdwuu");
  mutate = true;
  editor.onChange = () => {
    if (mutate) {
      mutate = false;
      editor.insertTextAtCursor("Z");
    }
  };
  editor.handleInput("\x12");
  const afterRedoCallback = editor.getText();
  editor.handleInput("\x12");
  assert.equal(editor.getText(), afterRedoCallback);
});

test("change/delete ranges and resulting cursors match clean Neovim", async (t) => {
  if (spawnSync("nvim", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("Neovim is not installed");
    return;
  }
  const cases = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const lines of [
    ["abc def  "],
    ["  foo.bar baz"],
    ["   "],
    [""],
    ["one two", "  three", "", "last"],
    ["", "  next", ""],
    ["  one", "two"],
    ["one", "two"],
    ["one two", "three"],
    ["one two", "", "three"],
    ["one", "   ", "last"],
    ["Äpfel café", "e\u0301x 👨‍👩‍👧‍👦 done"],
    ...unicodeFixtures,
  ]) {
    for (const [line, text] of lines.entries()) {
      const positions = [...segmenter.segment(text)].map((item) => item.index);
      for (const col of positions.length ? positions : [0]) {
        for (const command of [
          "cw",
          "ce",
          "cb",
          "c0",
          "c$",
          "cc",
          "C",
          "dw",
          "de",
          "db",
          "d0",
          "d$",
          "dd",
          "D",
        ]) {
          cases.push({
            lines,
            line,
            col,
            keys:
              command +
              (command.startsWith("c") || command === "C" ? "X\x1b" : ""),
          });
        }
      }
    }
  }
  const expected = neovim(cases);
  const { editor } = await harness();
  const failures = [];
  for (const [index, item] of cases.entries()) {
    normalAt(editor, item.lines, item.line, item.col);
    keys(editor, item.keys);
    const result = expected[index];
    const [line, bytecol] = result.cursor;
    const col = Buffer.from(result.lines[line - 1])
      .subarray(0, bytecol)
      .toString().length;
    const actual = { lines: editor.getLines(), cursor: editor.getCursor() };
    const wanted = { lines: result.lines, cursor: { line: line - 1, col } };
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      failures.push({ input: item, actual, expected: wanted });
    }
    assertMode(editor, "NORMAL");
  }
  assert.equal(
    failures.length,
    0,
    JSON.stringify(failures.slice(0, 12), null, 2),
  );
  t.diagnostic(`${cases.length} operator cases match clean Neovim.`);
});

for (const tuiMode of ["regular", "fullscreen"]) {
  test(
    `real Pi PTY ${tuiMode} changes, deletes, undoes, redoes and reloads the Vim editor`,
    {
      skip:
        process.platform === "win32" ||
        spawnSync("python3", ["--version"]).status !== 0,
      timeout: 20_000,
    },
    (t) => {
      const home = mkdtempSync(join(tmpdir(), "pi-vim-pty-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      mkdirSync(join(home, "agent"));
      const script = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct, re
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup)
os.close(slave)
data = b''
def wait_for(marker):
    global data
    end = time.time() + 6
    while marker not in re.sub(rb'\\x1b\\[[0-?]*[ -/]*[@-~]', b'', data):
        if time.time() > end: raise RuntimeError('missing '+repr(marker)+' in '+repr(data[-2000:]))
        if select.select([master], [], [], .05)[0]: data += os.read(master, 65536)
def send(text):
    global data
    data = b''
    os.write(master, text)
try:
    wait_for(b'INSERT')
    send(b'hello')
    wait_for(b'hello')
    send(b'\\x1b')
    wait_for(b'NORMAL')
    send(b'0lxiX')
    wait_for(b'hXllo')
    wait_for(b'INSERT')
    send(b'\\x1b')
    wait_for(b'NORMAL')
    send(b'\\x03')
    wait_for(b'INSERT')
    send(b'/reload\\r')
    wait_for(b'Reloaded keybindings, extensions')
    wait_for(b'INSERT')
    send(b'again')
    wait_for(b'again')
    send(b'\\x1b')
    wait_for(b'NORMAL')
    send(b'0x')
    wait_for(b'gain')
    send(b'df')
    wait_for('df · NORMAL'.encode())
    send(b'iaQ')
    wait_for(b'nQ')
    send(b'\\x1b')
    wait_for(b'NORMAL')
    send(b'uu')
    wait_for(b'gain')
    send(b'c')
    wait_for('c · NORMAL'.encode())
    send(b'wNEW WORD')
    wait_for(b'NEW WORD')
    wait_for(b'INSERT')
    send(b'\\x1b')
    wait_for(b'NORMAL')
    send(b'u')
    wait_for(b'gain')
    send(b'\\x12')
    wait_for(b'NEW WORD')
    send(b'u')
    wait_for(b'gain')
    send(b'd')
    wait_for('d · NORMAL'.encode())
    send(b'\\x1b[5~')
    wait_for(b'NORMAL')
    send(b'w')
    wait_for(b'gain')
    send(b'd')
    wait_for('d · NORMAL'.encode())
    send(b'd')
    wait_for(b'NORMAL')
    send(b'u')
    wait_for(b'gain')
    send(b'\\x01\\x0b')
    wait_for(b'INSERT')
    send(b'\\x04')
    end = time.time() + 3
    while p.poll() is None and time.time() < end:
        if select.select([master], [], [], .05)[0]:
            try: data += os.read(master, 65536)
            except OSError: break
    p.wait(timeout=3)
    print(json.dumps({'exit': p.returncode}))
finally:
    if p.poll() is None: p.kill()
    os.close(master)
    p.wait(timeout=3)
`;
      const output = execFileSync(
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
          source,
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tui-mode",
          tuiMode,
        ],
        {
          cwd: home,
          encoding: "utf8",
          timeout: 18_000,
          env: {
            ...process.env,
            HOME: home,
            TERM: "xterm-256color",
            PI_CODING_AGENT_DIR: join(home, "agent"),
            TMUX: "",
            TMUX_PANE: "",
          },
        },
      );
      assert.deepEqual(JSON.parse(output), { exit: 0 });
    },
  );
}

test("w/b/e match clean Neovim on representative prompt positions", async (t) => {
  if (spawnSync("nvim", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("Neovim is not installed");
    return;
  }
  const cases = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const lines of [
    ["foo.bar  baz"],
    ["a,b! c_d  "],
    ["hello", "  next", "", "", "last"],
    ["", "   ", "", "x", ""],
    ["Äpfel café", "e\u0301x 👨‍👩‍👧‍👦 done"],
    ...unicodeFixtures,
  ]) {
    for (const [line, text] of lines.entries()) {
      const positions = [...segmenter.segment(text)].map((item) => item.index);
      for (const col of positions.length ? positions : [0]) {
        for (const key of ["w", "b", "e"]) {
          cases.push({ lines, line, col, key });
        }
      }
    }
  }
  const expected = neovim(cases).map((item) => item.cursor);
  const { editor } = await harness();
  for (const [index, item] of cases.entries()) {
    normalAt(editor, item.lines, item.line, item.col);
    editor.handleInput(item.key);
    const [line, bytecol] = expected[index];
    const col = Buffer.from(item.lines[line - 1])
      .subarray(0, bytecol)
      .toString().length;
    assert.deepEqual(
      editor.getCursor(),
      { line: line - 1, col },
      JSON.stringify(item),
    );
  }
});

test("f/F/t/T, ; and , match clean Neovim, alone and with c/d", async (t) => {
  if (spawnSync("nvim", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("Neovim is not installed");
    return;
  }
  const cases = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const positions = (text) => {
    const found = [...segmenter.segment(text)].map((item) => item.index);
    return found.length ? found : [0];
  };
  const plain = [
    ["a.b.c.d"],
    ["one.two..three"],
    ["foo bar  baz boo"],
    ["x"],
    [""],
    ["  o.o o"],
    ["one o", "two.o"],
  ];
  const unicode = [["Äpfel café", "e\u0301x 👨‍👩‍👧‍👦 done"], ...unicodeFixtures];
  for (const lines of [...plain, ...unicode]) {
    const chars = plain.includes(lines)
      ? [".", "o", " ", "b", "z"]
      : ["o", "e", "é", "b", "🙂", "你", "a"];
    for (const [line, text] of lines.entries()) {
      for (const col of positions(text)) {
        for (const motion of ["f", "F", "t", "T"]) {
          for (const char of chars) {
            // Vim's Te stops inside a decomposed é. Pi keeps it whole.
            const decomposed = lines.some((text) => text.includes("\u0301"));
            if (motion === "T" && char === "e" && decomposed) continue;
            const find = motion + char;
            for (const keys of [
              find,
              `d${find}`,
              `c${find}X\x1b`,
              ...(plain.includes(lines)
                ? [
                    [find, ";"],
                    [find, ","],
                    [find, ";", ";"],
                    [find, "d;"],
                    [find, "c,X\x1b"],
                  ]
                : []),
            ]) {
              cases.push({ lines, line, col, keys });
            }
          }
        }
      }
    }
  }
  const expected = neovim(cases);
  const { editor } = await harness();
  const failures = [];
  for (const [index, item] of cases.entries()) {
    normalAt(editor, item.lines, item.line, item.col);
    keys(editor, [item.keys].flat().join(""));
    const result = expected[index];
    const [line, bytecol] = result.cursor;
    const col = Buffer.from(result.lines[line - 1])
      .subarray(0, bytecol)
      .toString().length;
    const actual = { lines: editor.getLines(), cursor: editor.getCursor() };
    const wanted = { lines: result.lines, cursor: { line: line - 1, col } };
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      failures.push({ input: item, actual, expected: wanted });
    }
    assertMode(editor, "NORMAL");
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} failures: ${JSON.stringify(failures.slice(0, 12), null, 2)}`,
  );
  t.diagnostic(`${cases.length} find cases match clean Neovim.`);
});

test("counts match clean Neovim for motions and operators", async (t) => {
  if (spawnSync("nvim", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("Neovim is not installed");
    return;
  }
  const cases = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const lines of [
    ["one two three"],
    ["a b", "c d"],
    ["one two", "  three", "", "last"],
    ["", "  next", ""],
    ["  ", "", "foo"],
    ["  o.o o", "two.o", "x"],
    ["Äpfel café", "e\u0301x 👨‍👩‍👧‍👦 done"],
  ]) {
    for (const [line, text] of lines.entries()) {
      const positions = [...segmenter.segment(text)].map((item) => item.index);
      for (const col of positions.length ? positions : [0]) {
        for (const n of ["2", "3", "10"]) {
          for (const command of [
            `${n}w`,
            `${n}b`,
            `${n}e`,
            `${n}h`,
            `${n}l`,
            `${n}j`,
            `${n}k`,
            `${n}$`,
            `${n}x`,
            `${n}fo`,
            `${n}To`,
            `d${n}w`,
            `${n}dw`,
            `c${n}wX\x1b`,
            `d${n}b`,
            `c${n}bX\x1b`,
            `d${n}e`,
            `c${n}eX\x1b`,
            `${n}dd`,
            `${n}ccX\x1b`,
            `${n}D`,
            `${n}CX\x1b`,
            `d${n}l`,
            `c${n}hX\x1b`,
            `${n}dto`,
            `c${n}FoX\x1b`,
            `${n}d0`,
            ["to", `${n};`],
            ["fo", `d${n},`],
          ]) {
            cases.push({ lines, line, col, keys: command });
          }
        }
        for (const command of ["2d3w", "dl", "dh", "clX\x1b", "chX\x1b"]) {
          cases.push({ lines, line, col, keys: command });
        }
      }
    }
  }
  const expected = neovim(cases);
  const { editor } = await harness();
  const failures = [];
  for (const [index, item] of cases.entries()) {
    normalAt(editor, item.lines, item.line, item.col);
    keys(editor, [item.keys].flat().join(""));
    const result = expected[index];
    const [line, bytecol] = result.cursor;
    const col = Buffer.from(result.lines[line - 1])
      .subarray(0, bytecol)
      .toString().length;
    const actual = { lines: editor.getLines(), cursor: editor.getCursor() };
    const wanted = { lines: result.lines, cursor: { line: line - 1, col } };
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      failures.push({ input: item, actual, expected: wanted });
    }
    assertMode(editor, "NORMAL");
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} failures: ${JSON.stringify(failures.slice(0, 12), null, 2)}`,
  );
  t.diagnostic(`${cases.length} count cases match clean Neovim.`);
});
