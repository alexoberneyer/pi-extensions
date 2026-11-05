import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { findPackageJSON } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";

const packageDir =
  process.env.PI_TEST_PACKAGE_DIR ||
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { SessionManager } = await import(
  pathToFileURL(join(packageDir, "dist/core/session-manager.js"))
);
const aiDir = join(
  dirname(
    findPackageJSON(
      "@earendil-works/pi-ai",
      pathToFileURL(join(packageDir, "package.json")),
    ),
  ),
  "dist",
);
const { getModel } = await import(pathToFileURL(join(aiDir, "compat.js")));
const { streamSimple: streamCodex } = await import(
  pathToFileURL(join(aiDir, "api/openai-codex-responses.js"))
);
const { streamSimple: streamOpenAI } = await import(
  pathToFileURL(join(aiDir, "api/openai-responses.js"))
);
const source = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extensions/fast/index.ts",
);
const model = getModel("openai-codex", "gpt-6-astra");
const solModels = [
  getModel("openai", "gpt-6.1-sol"),
  getModel("openai-codex", "gpt-6.1-sol"),
];
const STATE = "astra-fast";

async function harness(
  manager = SessionManager.inMemory(),
  hasUI = true,
  activeModel = model,
  defaultTier = "priority",
) {
  const directory = mkdtempSync(join(tmpdir(), "fast-config-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({ fast: { defaultTier } }));
  const previous = process.env.PI_EXTENSIONS_CONFIG;
  process.env.PI_EXTENSIONS_CONFIG = path;
  let loaded;
  try {
    loaded = await loadExtensions([source], process.cwd());
  } finally {
    if (previous === undefined) delete process.env.PI_EXTENSIONS_CONFIG;
    else process.env.PI_EXTENSIONS_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  loaded.runtime.appendEntry = (type, data) =>
    manager.appendCustomEntry(type, data);
  const notices = [];
  const statuses = new Map();
  const ctx = {
    model: activeModel,
    hasUI,
    sessionManager: manager,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (key, value) => statuses.set(key, value),
    },
  };
  async function emit(type, event = {}) {
    let result;
    for (const handler of extension.handlers.get(type) || []) {
      result = await handler({ type, ...event }, ctx);
    }
    return result;
  }
  await emit("session_start");
  return {
    manager,
    ctx,
    emit,
    notices,
    statuses,
    command: (args) => extension.commands.get("fast").handler(args, ctx),
    request: (payload = { model: ctx.model?.id }) =>
      emit("before_provider_request", { payload }),
  };
}

test("configured priority preserves reasoning and all other request fields", async () => {
  const h = await harness();
  const payload = {
    model: model.id,
    reasoning: { effort: "xhigh", summary: "auto" },
    tools: [{ type: "function", name: "read" }],
    input: [],
    stream: true,
  };
  const original = structuredClone(payload);
  assert.deepEqual(await h.request(payload), {
    ...payload,
    service_tier: "priority",
  });
  assert.deepEqual(payload, original);
  assert.equal(h.statuses.get(STATE), "fast: on");
  assert.deepEqual(h.manager.getBranch(), []);
});

test("safe default leaves provider tiers untouched in interactive and headless modes", async () => {
  for (const hasUI of [true, false]) {
    const h = await harness(undefined, hasUI, model, "off");
    assert.equal(await h.request(), undefined);
    const payload = { model: model.id, service_tier: "flex" };
    assert.equal(await h.request(payload), undefined);
    assert.equal(payload.service_tier, "flex");
    await h.command("on");
    assert.equal((await h.request()).service_tier, "priority");
    const restored = await harness(h.manager, hasUI, model, "off");
    assert.equal((await restored.request()).service_tier, "priority");
  }
});

test("toggle, explicit settings, status and invalid arguments", async () => {
  const h = await harness();
  await h.command("status");
  assert.equal(h.manager.getBranch().length, 0);
  assert.match(h.notices.at(-1).message, /increased usage/);
  await h.command("");
  assert.equal(await h.request(), undefined);
  assert.equal(h.statuses.get(STATE), "fast: off");
  await h.command(" ON ");
  assert.equal((await h.request()).service_tier, "priority");
  await h.command("off");
  const entries = h.manager.getBranch().length;
  await h.command("status");
  await h.command("invalid");
  assert.equal(h.manager.getBranch().length, entries);
  assert.equal(h.notices.at(-1).level, "error");
  assert.equal(await h.request(), undefined);
  await h.command("");
  assert.equal((await h.request()).service_tier, "priority");
});

test("off leaves existing service tiers untouched", async () => {
  const h = await harness();
  await h.command("off");
  const payload = { model: model.id, service_tier: "flex" };
  assert.equal(await h.request(payload), undefined);
  assert.equal(payload.service_tier, "flex");
});

test("ignores unsupported models, providers and APIs", async () => {
  const h = await harness();
  for (const other of [
    undefined,
    { ...model, provider: "openai" },
    { ...model, id: "gpt-6-sol" },
    { ...model, api: "openai-responses" },
    { ...solModels[0], provider: "openrouter" },
    { ...solModels[0], api: "openai-completions" },
    { ...solModels[1], api: "openai-responses" },
  ]) {
    h.ctx.model = other;
    assert.equal(await h.request(), undefined);
    await h.emit("model_select");
    assert.equal(h.statuses.get(STATE), undefined);
  }
  await h.command("on");
  assert.match(h.notices.at(-1).message, /Inactive on this model/);
  h.ctx.model = model;
  await h.emit("model_select");
  assert.equal(h.statuses.get(STATE), "fast: on");
  for (const payload of [null, "text", [], {}, { model: "gpt-6.1-sol" }]) {
    assert.equal(await h.request(payload), undefined);
  }
});

test("restores saved state on reload/resume and respects configured defaults", async () => {
  const first = await harness();
  await first.command("off");
  const reloaded = await harness(first.manager);
  assert.equal(await reloaded.request(), undefined);
  assert.equal(reloaded.statuses.get(STATE), "fast: off");
  const fresh = await harness();
  assert.equal((await fresh.request()).service_tier, "priority");
});

test("tree navigation restores only the active branch and skips invalid data", async () => {
  const h = await harness();
  await h.command("off");
  const off = h.manager.getLeafId();
  await h.command("on");
  h.manager.branch(off);
  h.manager.appendCustomEntry(STATE, { enabled: "true" });
  h.manager.appendCustomEntry(STATE, null);
  h.manager.appendCustomEntry("unrelated", { enabled: true });
  await h.emit("session_tree");
  assert.equal(await h.request(), undefined);
  assert.equal(h.statuses.get(STATE), "fast: off");
  assert.equal(h.manager.getEntries().length, 5);
});

test("request behavior works without UI and shutdown clears the footer", async () => {
  const h = await harness(undefined, false);
  assert.equal(h.statuses.size, 0);
  assert.equal((await h.request()).service_tier, "priority");
  const interactive = await harness();
  await interactive.emit("session_shutdown");
  assert.equal(interactive.statuses.get(STATE), undefined);
});

for (const sol of solModels) {
  test(`${sol.provider}/Sol configured priority preserves request fields`, async () => {
    const h = await harness(undefined, true, sol);
    const payload = {
      model: sol.id,
      reasoning: { effort: "xhigh", summary: "auto" },
      input: [],
      service_tier: "flex",
      stream: true,
    };
    const original = structuredClone(payload);
    assert.deepEqual(await h.request(payload), {
      ...payload,
      service_tier: "priority",
    });
    assert.deepEqual(payload, original);
    assert.equal(h.statuses.get(STATE), "fast: on");
    await h.command("status");
    assert.doesNotMatch(h.notices.at(-1).message, /Inactive/);
    for (const invalid of [null, "text", [], {}, { model: model.id }]) {
      assert.equal(await h.request(invalid), undefined);
    }
    await h.command("");
    assert.equal(await h.request(payload), undefined);
    assert.deepEqual(payload, original);
    assert.equal(h.statuses.get(STATE), "fast: off");
    await h.command("on");
    assert.equal((await h.request()).service_tier, "priority");
    const headless = await harness(undefined, false, sol);
    assert.equal((await headless.request()).service_tier, "priority");
    assert.equal(headless.statuses.size, 0);
  });

  test(`${sol.provider}/Sol shares and restores saved Astra state`, async () => {
    const astra = await harness();
    await astra.command("off");
    astra.ctx.model = sol;
    await astra.emit("model_select");
    assert.equal(astra.statuses.get(STATE), "fast: off");
    assert.equal(await astra.request(), undefined);
    const h = await harness(astra.manager, true, sol);
    assert.equal(await h.request(), undefined);
    assert.equal(h.statuses.get(STATE), "fast: off");
    const off = h.manager.getLeafId();
    await h.command("on");
    h.manager.branch(off);
    await h.emit("session_tree");
    assert.equal(await h.request(), undefined);
    assert.equal(h.statuses.get(STATE), "fast: off");
    const fresh = await harness(undefined, true, sol);
    assert.equal((await fresh.request()).service_tier, "priority");
  });
}

for (const activeModel of [model, ...solModels]) {
  test(`${activeModel.provider}/${activeModel.id} supports explicit Ultra with a cost and eligibility warning`, async () => {
    const h = await harness(undefined, true, activeModel);
    await h.command(" ULTRA ");
    const payload = {
      model: activeModel.id,
      reasoning: { effort: "xhigh", summary: "auto" },
      service_tier: "flex",
      input: [],
      stream: true,
    };
    const original = structuredClone(payload);
    assert.deepEqual(await h.request(payload), {
      ...payload,
      service_tier: "ultrafast",
    });
    assert.deepEqual(payload, original);
    assert.equal(h.statuses.get(STATE), "fast: ultra (requested)");
    assert.equal(h.notices.at(-1).level, "warning");
    assert.match(
      h.notices.at(-1).message,
      /Availability depends on provider and account/,
    );
    assert.match(
      h.notices.at(-1).message,
      /Increased allowance consumption and charges/,
    );
    assert.match(h.notices.at(-1).message, /API keys are billed separately/);
    assert.match(
      h.notices.at(-1).message,
      /cost can underestimate actual provider charges/,
    );
    assert.deepEqual(h.manager.getBranch().at(-1).data, {
      enabled: true,
      tier: "ultrafast",
    });
    const entries = h.manager.getBranch().length;
    await h.command("status");
    await h.command("invalid");
    assert.equal(h.manager.getBranch().length, entries);
    assert.equal((await h.request()).service_tier, "ultrafast");
    await h.command("");
    assert.equal(await h.request(payload), undefined);
    assert.deepEqual(payload, original);
    assert.equal(h.statuses.get(STATE), "fast: off");
    await h.command("");
    assert.equal((await h.request()).service_tier, "priority");
    const headless = await harness(undefined, false, activeModel);
    await headless.command("ultra");
    assert.equal((await headless.request()).service_tier, "ultrafast");
    assert.equal(headless.statuses.size, 0);
  });

  test(`${activeModel.provider}/${activeModel.id} restores Ultra on reload and active-branch navigation`, async () => {
    const first = await harness(undefined, true, activeModel);
    await first.command("ultra");
    const ultra = first.manager.getLeafId();
    const h = await harness(first.manager, true, activeModel);
    assert.equal((await h.request()).service_tier, "ultrafast");
    assert.equal(h.statuses.get(STATE), "fast: ultra (requested)");
    await h.command("off");
    assert.equal(await h.request(), undefined);
    await h.command("on");
    assert.equal((await h.request()).service_tier, "priority");
    h.manager.branch(ultra);
    h.manager.appendCustomEntry(STATE, { tier: "invalid" });
    h.manager.appendCustomEntry(STATE, null);
    await h.emit("session_tree");
    assert.equal((await h.request()).service_tier, "ultrafast");
    for (const invalid of [null, "text", [], {}, { model: "gpt-6-sol" }]) {
      assert.equal(await h.request(invalid), undefined);
    }
    h.ctx.model = { ...activeModel, id: "gpt-6-sol" };
    await h.emit("model_select");
    assert.equal(h.statuses.get(STATE), undefined);
    assert.equal(await h.request(), undefined);
    await h.command("status");
    assert.match(h.notices.at(-1).message, /Inactive on this model/);
    h.ctx.model = activeModel;
    await h.emit("model_select");
    assert.equal(h.statuses.get(STATE), "fast: ultra (requested)");
    await h.emit("session_shutdown");
    assert.equal(h.statuses.get(STATE), undefined);
  });
}

test("legacy Boolean entries restore and valid tiers take precedence", async () => {
  for (const [data, expected] of [
    [{ enabled: false }, undefined],
    [{ enabled: true }, "priority"],
    [{ enabled: true, tier: "off" }, undefined],
    [{ enabled: false, tier: "priority" }, "priority"],
    [{ enabled: false, tier: "ultrafast" }, "ultrafast"],
    [{ enabled: false, tier: "invalid" }, undefined],
  ]) {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry(STATE, data);
    const h = await harness(manager);
    assert.equal((await h.request())?.service_tier, expected);
  }
});

const claims = Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-only" },
  }),
).toString("base64url");
const fakeToken = `test.${claims}.test`;
for (const [activeModel, streamSimple, apiKey] of [
  [model, streamCodex, fakeToken],
  [solModels[1], streamCodex, fakeToken],
  [solModels[0], streamOpenAI, "sk-test-only"],
  [solModels[0], streamOpenAI, fakeToken],
]) {
  const auth = apiKey === fakeToken ? "subscription" : "API key";
  test(`${activeModel.provider}/${activeModel.id} (${auth}) serializes Fast and Ultra with xhigh and omits the tier when off`, async () => {
    const h = await harness(undefined, true, activeModel);
    const requests = [];
    const options = {
      apiKey,
      reasoning: "xhigh",
      transport: "sse",
      maxRetries: 0,
      onPayload: h.request,
      fetch: async (_url, init) => {
        const body =
          new Headers(init.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body).toString()
            : init.body;
        requests.push(JSON.parse(body));
        // Stop after inspecting the serialized request. No network call occurs.
        return new Response('{"error":{"message":"test transport stopped"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const context = {
      messages: [{ role: "user", content: "test", timestamp: 0 }],
    };
    for (const setting of ["on", "ultra", "off"]) {
      await h.command(setting);
      const result = await streamSimple(activeModel, context, options).result();
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage, /test transport stopped/);
      if (setting === "ultra") {
        assert.equal((await h.request()).service_tier, "ultrafast");
      }
    }
    assert.equal(requests.length, 3);
    // Pi 1.5 encodes API-key mid-conversation effort in configuration_update.
    // Subscription transports continue using reasoning.effort directly.
    for (const request of requests) {
      const configuration = request.input?.findLast(
        (item) => item.type === "configuration_update",
      );
      assert.equal(
        configuration?.reasoning.effort ?? request.reasoning.effort,
        "xhigh",
      );
    }
    assert.equal(requests[0].model, activeModel.id);
    assert.equal(requests[0].service_tier, "priority");
    assert.equal(requests[1].service_tier, "ultrafast");
    assert.equal(requests[2].service_tier, undefined);
  });
}
