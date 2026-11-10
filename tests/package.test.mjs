import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hostPackage = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(hostPackage, "Run with node scripts/test.mjs.");
const require = createRequire(join(hostPackage, "package.json"));

function isolatedHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-package-test-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_EXTENSIONS_CONFIG: undefined,
    PI_SUPERVISOR_WORKER: undefined,
    SKILL_USAGE_LOG: undefined,
    PI_AGENTS_EXTERNAL: "1",
    PI_AGENTS_DEV01: "1",
    PI_QMD_REFRESH: "1",
    TMUX: "",
    TMUX_PANE: "",
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  return home;
}

test("the package declares ten portable extension entrypoints with host-owned peers", () => {
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, [
    "./extensions/approval/index.ts",
    "./extensions/agents/index.ts",
    "./extensions/comms/index.ts",
    "./extensions/dev01/index.ts",
    "./extensions/fast/index.ts",
    "./extensions/supervisor/index.ts",
    "./extensions/vim/index.ts",
    "./extensions/web/index.ts",
    "./extensions/workflows/index.ts",
    "./extensions/workstation/index.ts",
  ]);
  for (const entry of manifest.pi.extensions) {
    assert.equal(isAbsolute(entry), false);
    const path = realpathSync(resolve(root, entry));
    assert.ok(!relative(root, path).startsWith(".."), entry);
    assert.ok(manifest.files.includes("extensions/"));
  }
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies?.[name], undefined);
  }
});

test("all declared extensions load and start with isolated defaults, without external activity or workers", async (t) => {
  const home = isolatedHome(t);
  const { loadExtensions } = await import(
    pathToFileURL(join(hostPackage, "dist/core/extensions/loader.js"))
  );
  const { SessionManager } = await import(
    pathToFileURL(require.resolve("./dist/index.js"))
  );
  const { readConfig } = await import("../lib/config.mjs");
  const { remoteConfig } = await import("../bin/dev01.mjs");
  assert.equal(readConfig().remote.host, null);
  assert.equal(readConfig().fast.defaultTier, "off");
  assert.throws(() => remoteConfig(), /Remote access is disabled/);

  const forbidden = [];
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    forbidden.push(
      t.mock.method(childProcess, name, () =>
        assert.fail(`Startup must not call ${name}.`),
      ),
    );
  }
  forbidden.push(
    t.mock.method(globalThis, "fetch", () =>
      assert.fail("Startup must not fetch."),
    ),
    t.mock.method(net.Socket.prototype, "connect", () =>
      assert.fail("Startup must not open a network connection."),
    ),
    t.mock.method(tls, "connect", () =>
      assert.fail("Startup must not open a TLS connection."),
    ),
  );
  syncBuiltinESMExports();
  try {
    const loaded = await loadExtensions(
      manifest.pi.extensions.map((entry) => resolve(root, entry)),
      home,
    );
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 10);
    const tools = loaded.extensions.flatMap((extension) =>
      [...extension.tools.values()].map((tool) => tool.definition ?? tool),
    );
    const manager = SessionManager.inMemory(home);
    let activeTools = [
      "read",
      "bash",
      "edit",
      "write",
      ...tools
        .filter((tool) => tool.defaultActive !== false)
        .map((tool) => tool.name),
    ];
    loaded.runtime.getAllTools = () => tools;
    loaded.runtime.getActiveTools = () => [...activeTools];
    loaded.runtime.setActiveTools = (names) => {
      activeTools = names;
    };
    loaded.runtime.appendEntry = (type, data) =>
      manager.appendCustomEntry(type, data);
    loaded.runtime.getThinkingLevel = () => "off";
    loaded.runtime.sendMessage = () =>
      assert.fail("Startup must not send messages or start a model turn.");
    loaded.runtime.sendUserMessage = () =>
      assert.fail("Startup must not start a model turn.");
    const notices = [];
    const statuses = new Map();
    let editor;
    const ctx = {
      cwd: home,
      mode: "tui",
      hasUI: true,
      sessionManager: manager,
      isIdle: () => true,
      isProjectTrusted: () => true,
      model: {
        provider: "openai-codex",
        api: "openai-codex-responses",
        id: "gpt-6-astra",
      },
      modelRegistry: new Proxy(
        {},
        { get: () => assert.fail("Startup must not access a model provider.") },
      ),
      ui: {
        notify: (text, level) => notices.push({ text, level }),
        setStatus: (name, text) => statuses.set(name, text),
        setWidget() {},
        getEditorComponent: () => editor,
        setEditorComponent: (factory) => {
          editor = factory;
        },
        confirm: () =>
          assert.fail("Default startup must not request approval."),
      },
    };
    async function emit(type, event = {}) {
      const results = [];
      for (const extension of loaded.extensions) {
        for (const handler of extension.handlers.get(type) ?? []) {
          const result = await handler({ type, ...event }, ctx);
          if (result !== undefined) results.push(result);
        }
      }
      return results;
    }
    const queue = tools.filter((tool) => tool.name.startsWith("comms_"));
    assert.deepEqual(queue.map((tool) => tool.name).sort(), [
      "comms_ingest",
      "comms_save_draft",
      "comms_snapshot",
    ]);
    assert.ok(queue.every((tool) => tool.defaultActive === false));
    try {
      await emit("session_start", { reason: "startup" });
      assert.equal(statuses.get("astra-fast"), "fast: off");
      assert.equal(activeTools.includes("supervisor"), false);
      for (const tool of queue) {
        assert.equal(activeTools.includes(tool.name), false);
        const results = await emit("tool_call", {
          toolName: tool.name,
          input: {},
          toolCallId: tool.name,
        });
        assert.ok(results.some((result) => result.block === true));
      }
      assert.ok(
        (
          await emit("tool_call", {
            toolName: "supervisor",
            input: {},
            toolCallId: "workers",
          })
        ).some((result) => result.block === true),
      );
      const supervisor = tools.find((tool) => tool.name === "supervisor");
      await assert.rejects(
        supervisor.execute(
          "workers",
          { action: "list" },
          undefined,
          undefined,
          ctx,
        ),
        /Supervision is off/,
      );
      const payload = { model: ctx.model.id, messages: [] };
      assert.deepEqual(await emit("before_provider_request", { payload }), []);
      assert.deepEqual(payload, { model: ctx.model.id, messages: [] });
      const options = { sections: {}, promptGuidelines: [] };
      await emit("before_agent_start", {
        messageType: "user",
        systemPromptOptions: options,
      });
      assert.equal(options.sections.workstation_memory, undefined);
      assert.equal(options.sections.workstation_output_style, undefined);
      assert.equal(options.sections.supervisor, undefined);
      assert.deepEqual(
        await emit("resources_discover", { cwd: home, reason: "startup" }),
        [{ skillPaths: [], promptPaths: [] }],
      );
      assert.equal(existsSync(join(home, "agent/comms")), false);
      assert.equal(existsSync(join(home, "agent/supervisor")), false);
      assert.deepEqual(notices, []);
    } finally {
      await emit("session_shutdown", { reason: "quit" });
    }
    for (const mock of forbidden) assert.equal(mock.mock.callCount(), 0);
  } finally {
    for (const mock of forbidden) mock.mock.restore();
    syncBuiltinESMExports();
  }
});
