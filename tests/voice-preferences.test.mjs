import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configPath } from "../lib/config.mjs";
import {
  createVoicePreferences,
  voicePreferencePath,
} from "../extensions/voice/preferences.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), "pi-voice-preferences-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    HOME: home,
    XDG_CONFIG_HOME: undefined,
    PI_EXTENSIONS_CONFIG: undefined,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  return { home, file: join(home, "private", "voice-state.json") };
}

function restoreMocks(t) {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function failsWith(message) {
  return (error) => {
    assert.equal(error.message, message);
    assert.ok(error.cause instanceof Error);
    return true;
  };
}

const cannotRead = failsWith("Cannot read saved Voice preference.");
const cannotSave = failsWith("Cannot save Voice preference.");

test("the preference follows default, XDG and explicitly selected config paths", (t) => {
  const { home } = fixture(t);
  assert.equal(
    voicePreferencePath(),
    join(home, ".config", "pi-extensions", "voice-state.json"),
  );
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  assert.equal(
    voicePreferencePath(),
    join(home, "xdg", "pi-extensions", "voice-state.json"),
  );
  for (const selected of [
    join(home, "profile", "custom.json"),
    "~/profile/custom.json",
    "profile/custom.json",
  ]) {
    process.env.PI_EXTENSIONS_CONFIG = selected;
    assert.equal(
      voicePreferencePath(),
      join(home, "profile", "voice-state.json"),
    );
    assert.equal(
      voicePreferencePath(),
      join(dirname(configPath()), "voice-state.json"),
    );
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("each factory pins its path before later environment overrides", (t) => {
  const { home, file } = fixture(t);
  const canonical = createVoicePreferences();
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  const xdg = createVoicePreferences();
  process.env.PI_EXTENSIONS_CONFIG = join(home, "profile", "custom.json");
  const profile = createVoicePreferences();
  const explicit = createVoicePreferences(file);
  process.env.PI_EXTENSIONS_CONFIG = join(home, "unused", "config.json");
  process.env.XDG_CONFIG_HOME = join(home, "also-unused");
  canonical.write(true);
  xdg.write(false);
  profile.write(true);
  explicit.write(false);
  for (const [path, expected] of [
    [join(home, ".config", "pi-extensions", "voice-state.json"), true],
    [join(home, "xdg", "pi-extensions", "voice-state.json"), false],
    [join(home, "profile", "voice-state.json"), true],
    [file, false],
  ]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), {
      version: 1,
      enabled: expected,
    });
  }
  assert.equal(canonical.read(), true);
  assert.equal(xdg.read(), false);
  assert.equal(profile.read(), true);
  assert.equal(explicit.read(), false);
  assert.equal(fs.existsSync(join(home, "unused")), false);
  assert.equal(fs.existsSync(join(home, "also-unused")), false);
});

test("a selected config named voice-state.json gets a distinct preference filename", (t) => {
  const { file } = fixture(t);
  fs.mkdirSync(dirname(file), { recursive: true });
  const original = '{"voice":{"shortcut":"ctrl+space"}}';
  fs.writeFileSync(file, original);
  process.env.PI_EXTENSIONS_CONFIG = file;
  assert.equal(
    voicePreferencePath(),
    join(dirname(file), "voice-preferences.json"),
  );
  const store = createVoicePreferences();
  store.write(true);
  assert.equal(store.read(), true);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("explicit preference paths cannot replace the selected configuration", (t) => {
  const { file } = fixture(t);
  fs.mkdirSync(dirname(file), { recursive: true });
  const original = '{"voice":{"mode":"hold"}}';
  fs.writeFileSync(file, original);
  process.env.PI_EXTENSIONS_CONFIG = file;
  const store = createVoicePreferences(file);
  assert.throws(() => store.read(), cannotRead);
  assert.throws(() => store.write(false), cannotSave);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dirname(file)), ["voice-state.json"]);
});

for (const alias of ["symlink", "hardlink"]) {
  test(
    `a preference ${alias} to configuration is rejected without overwriting it`,
    { skip: process.platform === "win32" },
    (t) => {
      const { file } = fixture(t);
      fs.mkdirSync(dirname(file), { recursive: true });
      const selected = join(dirname(file), "config.json");
      const original = '{"voice":{"space":false}}';
      fs.writeFileSync(selected, original);
      process.env.PI_EXTENSIONS_CONFIG = selected;
      if (alias === "symlink") fs.symlinkSync(selected, file);
      else fs.linkSync(selected, file);
      const store = createVoicePreferences();
      assert.throws(() => store.read(), cannotRead);
      assert.throws(() => store.write(true), cannotSave);
      assert.equal(fs.readFileSync(selected, "utf8"), original);
    },
  );
}

test(
  "configuration aliases introduced after construction cannot be overwritten",
  { skip: process.platform === "win32" },
  (t) => {
    const { file } = fixture(t);
    const selected = join(dirname(file), "config.json");
    process.env.PI_EXTENSIONS_CONFIG = selected;
    const store = createVoicePreferences();
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(selected, "{}");
    fs.symlinkSync(selected, file);
    assert.throws(() => store.write(true), cannotSave);
    assert.equal(fs.readFileSync(selected, "utf8"), "{}");
  },
);

test("missing preferences are off without creating their parent", (t) => {
  const { file } = fixture(t);
  const store = createVoicePreferences(file);
  assert.equal(store.read(), false);
  assert.equal(fs.existsSync(dirname(file)), false);
});

test("boolean round trips contain only the version and enabled preference", (t) => {
  const { file } = fixture(t);
  const first = createVoicePreferences(file);
  const second = createVoicePreferences(file);
  for (const enabled of [true, false, true]) {
    assert.equal(first.write(enabled), undefined);
    assert.equal(first.read(), enabled);
    assert.equal(second.read(), enabled);
    assert.equal(createVoicePreferences(file).read(), enabled);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      `${JSON.stringify({ version: 1, enabled })}\n`,
    );
  }
  second.write(false);
  assert.equal(first.read(), false);
  fs.unlinkSync(file);
  assert.equal(first.read(), false);
  assert.deepEqual(fs.readdirSync(dirname(file)), []);
});

test("new preference files and parent directories are private", (t) => {
  const { home } = fixture(t);
  const file = join(home, "private", "nested", "voice-state.json");
  createVoicePreferences(file).write(true);
  if (process.platform !== "win32") {
    for (const directory of [dirname(file), dirname(dirname(file))])
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dirname(file)), ["voice-state.json"]);
});

test("saving preserves existing parent permissions and other configuration", (t) => {
  const { file } = fixture(t);
  const directory = dirname(file);
  fs.mkdirSync(directory);
  fs.chmodSync(directory, 0o755);
  const config = join(directory, "config.json");
  fs.writeFileSync(config, "synthetic configuration, deliberately not JSON\n");
  process.env.PI_EXTENSIONS_CONFIG = config;
  fs.writeFileSync(file, '{"version":1,"enabled":false}');
  fs.chmodSync(file, 0o644);
  const store = createVoicePreferences();
  store.write(true);
  assert.equal(store.read(), true);
  assert.equal(
    fs.readFileSync(config, "utf8"),
    "synthetic configuration, deliberately not JSON\n",
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "config.json",
    "voice-state.json",
  ]);
});

test("malformed JSON and every invalid schema fail closed without cached state", (t) => {
  const { file } = fixture(t);
  const store = createVoicePreferences(file);
  store.write(true);
  assert.equal(store.read(), true);
  for (const text of [
    "",
    "{",
    '{"version":1,"enabled":true,}',
    ...[
      null,
      [],
      true,
      1,
      "preference",
      {},
      { version: 1 },
      { enabled: true },
      { version: 0, enabled: true },
      { version: 2, enabled: true },
      { version: 1.5, enabled: true },
      { version: "1", enabled: true },
      { version: null, enabled: true },
      { version: 1, enabled: null },
      { version: 1, enabled: 1 },
      { version: 1, enabled: "false" },
      { version: 1, enabled: [] },
      { version: 1, enabled: {} },
      { version: 1, enabled: true, unexpected: true },
    ].map((value) => JSON.stringify(value)),
    '{"__proto__":{"version":1,"enabled":true}}',
  ]) {
    fs.writeFileSync(file, text);
    assert.throws(() => store.read(), cannotRead);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  store.write(false);
  assert.equal(store.read(), false);
});

test("read failures other than a missing file have a generic message", (t) => {
  const { file } = fixture(t);
  fs.mkdirSync(file, { recursive: true });
  const store = createVoicePreferences(file);
  assert.throws(() => store.read(), cannotRead);
  restoreMocks(t);
  const cause = Object.assign(new Error("synthetic private diagnostic"), {
    code: "EACCES",
  });
  t.mock.method(fs, "readFileSync", () => {
    throw cause;
  });
  syncBuiltinESMExports();
  assert.throws(
    () => store.read(),
    (error) => {
      cannotRead(error);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("nonboolean writes are rejected before any filesystem mutation", (t) => {
  const { file } = fixture(t);
  const store = createVoicePreferences(file);
  restoreMocks(t);
  const mkdir = t.mock.method(fs, "mkdirSync", () =>
    assert.fail("invalid writes must not create a directory"),
  );
  syncBuiltinESMExports();
  for (const value of [
    undefined,
    null,
    0,
    1,
    NaN,
    "",
    "true",
    [],
    {},
    new Boolean(true),
    1n,
    Symbol("synthetic"),
  ])
    assert.throws(() => store.write(value), cannotSave);
  assert.equal(mkdir.mock.callCount(), 0);
  assert.equal(fs.existsSync(dirname(file)), false);
});

for (const operation of [
  "mkdirSync",
  "openSync",
  "writeFileSync",
  "fsyncSync",
  "closeSync",
  "renameSync",
]) {
  test(`${operation} failure preserves the saved preference and cleans only its own temp`, (t) => {
    const { file } = fixture(t);
    const store = createVoicePreferences(file);
    store.write(true);
    const original = fs.readFileSync(file, "utf8");
    const stale = join(dirname(file), ".voice-state-stale.tmp");
    const config = join(dirname(file), "config.json");
    fs.writeFileSync(stale, "synthetic stale temp");
    fs.writeFileSync(config, "synthetic configuration");
    const before = fs.readdirSync(dirname(file)).sort();
    const cause = new Error("synthetic save failure");
    restoreMocks(t);
    const perform = fs[operation];
    let descriptor;
    const open = fs.openSync;
    if (operation !== "openSync")
      t.mock.method(fs, "openSync", (...args) => {
        descriptor = open(...args);
        return descriptor;
      });
    t.mock.method(fs, operation, (...args) => {
      if (operation === "writeFileSync") perform(args[0], "{");
      if (operation === "closeSync") perform(...args);
      throw cause;
    });
    syncBuiltinESMExports();
    assert.throws(
      () => store.write(false),
      (error) => {
        cannotSave(error);
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.equal(store.read(), true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.readFileSync(stale, "utf8"), "synthetic stale temp");
    assert.equal(fs.readFileSync(config, "utf8"), "synthetic configuration");
    assert.deepEqual(fs.readdirSync(dirname(file)).sort(), before);
    if (descriptor !== undefined)
      assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  });
}

test("an exclusive temp collision cannot overwrite or remove another writer's file", (t) => {
  const { file } = fixture(t);
  const store = createVoicePreferences(file);
  store.write(true);
  restoreMocks(t);
  const open = fs.openSync;
  let collision;
  t.mock.method(fs, "openSync", (candidate, flags, mode) => {
    assert.equal(flags, "wx");
    assert.equal(mode, 0o600);
    collision = candidate;
    const fd = open(candidate, "wx", 0o600);
    fs.writeFileSync(fd, "synthetic other writer");
    fs.closeSync(fd);
    return open(candidate, flags, mode);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => store.write(false),
    (error) => {
      cannotSave(error);
      assert.equal(error.cause.code, "EEXIST");
      return true;
    },
  );
  assert.equal(store.read(), true);
  assert.equal(fs.readFileSync(collision, "utf8"), "synthetic other writer");
});

test("readers see complete snapshots while temp writes are synced and renamed", (t) => {
  const { file } = fixture(t);
  const writer = createVoicePreferences(file);
  const reader = createVoicePreferences(file);
  writer.write(false);
  restoreMocks(t);
  const write = fs.writeFileSync;
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  const events = [];
  let descriptor;
  t.mock.method(fs, "writeFileSync", (fd, ...args) => {
    descriptor = fd;
    write(fd, "{");
    assert.equal(reader.read(), false);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, args[0], 0, "utf8");
    events.push("write");
  });
  t.mock.method(fs, "fsyncSync", (fd) => {
    assert.equal(fd, descriptor);
    assert.equal(reader.read(), false);
    sync(fd);
    events.push("sync");
  });
  t.mock.method(fs, "renameSync", (source, destination) => {
    assert.deepEqual(events, ["write", "sync"]);
    assert.equal(dirname(source), dirname(destination));
    assert.equal(destination, file);
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    assert.equal(reader.read(), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(source, "utf8")), {
      version: 1,
      enabled: true,
    });
    if (process.platform !== "win32")
      assert.equal(fs.statSync(source).mode & 0o777, 0o600);
    rename(source, destination);
    assert.equal(reader.read(), true);
    events.push("rename");
  });
  syncBuiltinESMExports();
  writer.write(true);
  assert.deepEqual(events, ["write", "sync", "rename"]);
  assert.deepEqual(fs.readdirSync(dirname(file)), ["voice-state.json"]);
});

test("interleaved stores use distinct temps and the last rename wins", (t) => {
  const { file } = fixture(t);
  const first = createVoicePreferences(file);
  const second = createVoicePreferences(file);
  first.write(false);
  restoreMocks(t);
  const rename = fs.renameSync;
  const sources = new Set();
  t.mock.method(fs, "renameSync", (source, destination) => {
    assert.equal(sources.has(source), false);
    sources.add(source);
    if (sources.size === 1) {
      second.write(false);
      assert.equal(first.read(), false);
    }
    rename(source, destination);
  });
  syncBuiltinESMExports();
  first.write(true);
  assert.equal(sources.size, 2);
  assert.equal(first.read(), true);
  assert.equal(second.read(), true);
  assert.deepEqual(fs.readdirSync(dirname(file)), ["voice-state.json"]);
});

test("import and factory construction perform no I/O, process or timer work", async (t) => {
  const { home, file } = fixture(t);
  const forbidden = [];
  const guard = (object, names) => {
    for (const name of names)
      forbidden.push(
        t.mock.method(object, name, () => assert.fail(`Unexpected ${name}.`)),
      );
  };
  const listeners = process
    .eventNames()
    .map((name) => [name, process.listenerCount(name)]);
  const source = fileURLToPath(
    new URL("../extensions/voice/preferences.mjs", import.meta.url),
  );
  const sourceContent = fs.readFileSync(source);
  let loading = true;
  let sourceReads = 0;
  try {
    // Allow only Node's module-source load, served from memory.
    t.mock.method(fs, "readFileSync", (path) => {
      assert.equal(loading, true);
      assert.equal(path instanceof URL ? fileURLToPath(path) : path, source);
      assert.equal(++sourceReads, 1);
      return sourceContent;
    });
    guard(fs, [
      "writeFileSync",
      "appendFileSync",
      "openSync",
      "closeSync",
      "mkdirSync",
      "statSync",
      "existsSync",
      "readdirSync",
      "unlinkSync",
      "renameSync",
      "fsyncSync",
      "watch",
      "watchFile",
    ]);
    guard(fs.promises, ["readFile", "writeFile", "open", "mkdir", "rename"]);
    guard(childProcess, [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ]);
    guard(globalThis, ["setTimeout", "setInterval", "setImmediate"]);
    syncBuiltinESMExports();
    const cold = await import("../extensions/voice/preferences.mjs?cold");
    loading = false;
    assert.equal(
      cold.voicePreferencePath(),
      join(home, ".config", "pi-extensions", "voice-state.json"),
    );
    for (const store of [
      cold.createVoicePreferences(),
      cold.createVoicePreferences(file),
    ]) {
      assert.deepEqual(Object.keys(store), ["read", "write"]);
      assert.equal(typeof store.read, "function");
      assert.equal(typeof store.write, "function");
    }
    for (const mock of forbidden) assert.equal(mock.mock.callCount(), 0);
    assert.deepEqual(
      process.eventNames().map((name) => [name, process.listenerCount(name)]),
      listeners,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(home), []);
});
