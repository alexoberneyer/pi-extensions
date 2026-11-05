import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  configPath,
  defaults,
  expandPath,
  readConfig,
} from "../lib/config.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-config-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
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
  const path = join(home, "private", "config.json");
  mkdirSync(dirname(path));
  return {
    home,
    path,
    write(value) {
      writeFileSync(path, JSON.stringify(value));
      return path;
    },
  };
}

test("a missing default user config returns safe defaults", (t) => {
  const { home } = fixture(t);
  assert.equal(configPath(), join(home, ".config/pi-extensions/config.json"));
  const config = readConfig();
  assert.deepEqual(config, defaults);
  assert.equal(config.identity.timeZone, "UTC");
  assert.equal(config.remote.host, null);
  assert.equal(config.fast.defaultTier, "off");
  assert.deepEqual(config.approval.protectedCommands, []);
  assert.deepEqual(config.workstation, {
    memory: false,
    memoryDirectory: null,
    styleFile: null,
    skillPaths: [],
    promptPaths: [],
    qmdHook: null,
    usageLog: null,
  });
  delete process.env.XDG_CONFIG_HOME;
  assert.equal(configPath(), join(home, ".config/pi-extensions/config.json"));
  assert.deepEqual(readConfig(), defaults);
});

test("an explicitly selected missing config fails closed", (t) => {
  const { home, path } = fixture(t);
  assert.throws(
    () => readConfig(path),
    (error) => {
      assert.match(error.message, /Cannot read Pi extensions configuration/);
      assert.equal(error.cause?.code, "ENOENT");
      return true;
    },
  );
  process.env.PI_EXTENSIONS_CONFIG = path;
  assert.throws(() => readConfig(), /Cannot read Pi extensions configuration/);
  process.env.PI_EXTENSIONS_CONFIG = "~/private/missing.json";
  assert.equal(configPath(), join(home, "private/missing.json"));
  assert.throws(() => readConfig(), /Cannot read Pi extensions configuration/);
});

test("malformed, unreadable and non-object configs are errors rather than defaults", (t) => {
  const { path, write } = fixture(t);
  for (const text of ["", "{", '{"fast":', "// comment\n{}", '{"fast":{},}']) {
    writeFileSync(path, text);
    assert.throws(
      () => readConfig(path),
      /Cannot read Pi extensions configuration/,
    );
  }
  assert.throws(
    () => readConfig(dirname(path)),
    /Cannot read Pi extensions configuration/,
  );
  for (const value of [null, [], "config", true, 42]) {
    write(value);
    assert.throws(() => readConfig(path), /configuration must be an object/);
  }
});

test("unknown sections, unknown settings and invalid value types are rejected", (t) => {
  const { path, write } = fixture(t);
  for (const value of [
    { unknown: {} },
    { identity: { unknown: "example" } },
    { remote: { enabled: true } },
    { workstation: { logging: true } },
  ]) {
    write(value);
    assert.throws(() => readConfig(path), /Unknown configuration/);
  }
  for (const [section, values] of Object.entries(defaults)) {
    for (const value of [null, [], "example", false, 1]) {
      write({ [section]: value });
      assert.throws(() => readConfig(path), /Expected an object/);
    }
    for (const [key, expected] of Object.entries(values)) {
      const value = Array.isArray(expected)
        ? "not-an-array"
        : typeof expected === "boolean"
          ? "true"
          : 42;
      write({ [section]: { [key]: value } });
      assert.throws(
        () => readConfig(path),
        /Invalid configuration setting/,
        `${section}.${key}`,
      );
    }
  }
  for (const value of [[], null, {}, false, 1]) {
    write({ workstation: { memoryDirectory: value } });
    if (value === null)
      assert.equal(readConfig(path).workstation.memoryDirectory, null);
    else assert.throws(() => readConfig(path), /Invalid configuration setting/);
  }
  for (const value of [
    [null],
    [1],
    [false],
    [{}],
    [""],
    ["line\nbreak"],
    ["nul\0byte"],
    ["delete\x7f"],
  ]) {
    for (const key of ["skillPaths", "promptPaths"]) {
      write({ workstation: { [key]: value } });
      assert.throws(() => readConfig(path), /Invalid configuration setting/);
    }
    write({ approval: { protectedCommands: value } });
    assert.throws(() => readConfig(path), /Invalid configuration setting/);
  }
  for (const value of ["", "line\nbreak", "nul\0byte", "delete\x7f"]) {
    for (const [section, key] of [
      ["identity", "name"],
      ["workstation", "styleFile"],
    ]) {
      write({ [section]: { [key]: value } });
      assert.throws(() => readConfig(path), /Invalid configuration setting/);
    }
  }
});

test("invalid timezones, remote hosts, protected commands and implicit ultra tiers fail closed", (t) => {
  const { path, write } = fixture(t);
  for (const timeZone of ["Not/A_Timezone", "UTC; id", "Mars/Example"]) {
    write({ identity: { timeZone } });
    assert.throws(
      () => readConfig(path),
      /identity.timeZone must be an IANA timezone/,
    );
  }
  for (const host of [
    "-oProxyCommand=example",
    "example host",
    "example;id",
    "ssh://example",
    "user@example/dir",
    "$(id)",
  ]) {
    write({ remote: { host } });
    assert.throws(() => readConfig(path), /remote.host must be an SSH alias/);
  }
  for (const name of [
    "/workspace/example/bin/cli",
    "example-cli --help",
    "example;id",
    "-option",
  ]) {
    write({ approval: { protectedCommands: [name] } });
    assert.throws(
      () => readConfig(path),
      /protectedCommands must contain executable names/,
    );
  }
  for (const operation of ["/path/to/operation", "--option", "two words"]) {
    write({ approval: { readCommands: [operation] } });
    assert.throws(
      () => readConfig(path),
      /readCommands must contain reviewed operation names/,
    );
  }
  for (const defaultTier of ["ultra", "ultrafast", "on", "unknown"]) {
    write({ fast: { defaultTier } });
    assert.throws(
      () => readConfig(path),
      /fast.defaultTier must be off or priority/,
    );
  }
  write({
    identity: { name: "Example User", timeZone: "Europe/Paris" },
    remote: { host: "fixture@example-host" },
    approval: { protectedCommands: ["example-cli", "example.internal"] },
    fast: { defaultTier: "priority" },
  });
  const config = readConfig(path);
  assert.equal(config.identity.timeZone, "Europe/Paris");
  assert.equal(config.remote.host, "fixture@example-host");
  assert.equal(config.fast.defaultTier, "priority");
});

test("cwd configuration is ignored in favor of private user configuration", (t) => {
  const { home, write } = fixture(t);
  const cwd = join(home, "workspace/example");
  for (const name of [
    "config.json",
    "pi-extensions.json",
    ".pi/config.json",
    ".pi/pi-extensions.json",
    ".config/pi-extensions/config.json",
  ]) {
    const path = join(cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"fast":{"defaultTier":"ultrafast"}}');
  }
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    assert.deepEqual(readConfig(), defaults);
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"identity":{"name":"Example User"}}');
    assert.equal(readConfig().identity.name, "Example User");
    process.env.PI_EXTENSIONS_CONFIG = write({
      identity: { name: "Explicit User" },
    });
    assert.equal(readConfig().identity.name, "Explicit User");
  } finally {
    process.chdir(previous);
  }
});

test("configured local paths expand relative to the private config directory, not cwd", (t) => {
  const { home, path, write } = fixture(t);
  write({
    comms: {
      notesDirectory: "notes",
      triageInstructions: "instructions/triage.md",
      messageInstructions: "~/instructions/message.md",
      meetingInstructions: "/workspace/example/meeting.md",
      remarkableSource: "../scratchpad",
    },
    workstation: {
      memory: true,
      memoryDirectory: "memory",
      styleFile: "./style.md",
      usageLog: "logs/usage.jsonl",
      qmdHook: "~/hooks/refresh.sh",
      skillPaths: ["skills", "~/shared/skills", "/workspace/example/skills"],
      promptPaths: ["prompts"],
    },
    remote: { project: "~/workspace/example", sharedDirectory: "shared" },
  });
  const config = readConfig(path);
  const base = dirname(path);
  assert.deepEqual(config.comms, {
    ...defaults.comms,
    notesDirectory: join(base, "notes"),
    triageInstructions: join(base, "instructions/triage.md"),
    messageInstructions: join(home, "instructions/message.md"),
    meetingInstructions: "/workspace/example/meeting.md",
    remarkableSource: join(home, "scratchpad"),
  });
  assert.deepEqual(config.workstation, {
    memory: true,
    memoryDirectory: join(base, "memory"),
    styleFile: join(base, "style.md"),
    usageLog: join(base, "logs/usage.jsonl"),
    qmdHook: join(home, "hooks/refresh.sh"),
    skillPaths: [
      join(base, "skills"),
      join(home, "shared/skills"),
      "/workspace/example/skills",
    ],
    promptPaths: [join(base, "prompts")],
  });
  assert.equal(config.remote.project, "~/workspace/example");
  assert.equal(config.remote.sharedDirectory, "shared");
  assert.equal(expandPath("~"), home);
  assert.equal(expandPath("relative", base), join(base, "relative"));
  process.env.PI_EXTENSIONS_CONFIG = "private/config.json";
  assert.equal(configPath(), path);
  for (const value of [null, 1, "", "line\nbreak", "nul\0byte", "delete\x7f"]) {
    assert.throws(() => expandPath(value), /Expected a nonempty path/);
  }
  delete process.env.PI_EXTENSIONS_CONFIG;
  process.env.XDG_CONFIG_HOME = "relative";
  assert.throws(() => readConfig(), /XDG_CONFIG_HOME must be absolute/);
});

test("prototype keys cannot pollute defaults or returned configuration", (t) => {
  const { path } = fixture(t);
  const before = structuredClone(defaults);
  for (const text of [
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"toString":{}}',
    '{"workstation":{"__proto__":{"polluted":true}}}',
    '{"identity":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"approval":{"toString":"polluted"}}',
  ]) {
    writeFileSync(path, text);
    assert.throws(() => readConfig(path), /Unknown configuration/);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(defaults, before);
  }
});

test("reads are fresh, independent objects and never mutate defaults", (t) => {
  const { path, write } = fixture(t);
  const before = structuredClone(defaults);
  const first = readConfig();
  const second = readConfig();
  for (const section of Object.keys(defaults))
    assert.notEqual(first[section], second[section]);
  first.identity.name = "Changed";
  first.workstation.skillPaths.push("/workspace/example/changed");
  first.approval.protectedCommands.push("example-cli");
  assert.deepEqual(second, before);
  assert.deepEqual(readConfig(), before);
  write({
    workstation: { skillPaths: ["skills"] },
    fast: { defaultTier: "priority" },
  });
  const configured = readConfig(path);
  configured.workstation.skillPaths.push("/workspace/example/changed");
  assert.deepEqual(readConfig(path).workstation.skillPaths, [
    join(dirname(path), "skills"),
  ]);
  write({ fast: { defaultTier: "off" } });
  assert.equal(readConfig(path).fast.defaultTier, "off");
  writeFileSync(path, "{");
  assert.throws(
    () => readConfig(path),
    /Cannot read Pi extensions configuration/,
  );
  assert.deepEqual(defaults, before);
});
