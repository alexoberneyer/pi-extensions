import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_TEST_PACKAGE_DIR;
const { loadExtensions } = await import(
  pathToFileURL(join(host, "dist/core/extensions/loader.js"))
);
const { SessionManager } = await import(
  pathToFileURL(join(host, "dist/index.js"))
);

for (const names of [
  ["comms"],
  ["comms", "approval"],
  ["approval", "comms"],
  ["comms", "workflows", "supervisor"],
]) {
  test(`${names.join(" + ")} preserves handoff approval without an active collection job`, async () => {
    const loaded = await loadExtensions(
      names.map((name) => join(root, "extensions", name, "index.ts")),
      root,
    );
    assert.deepEqual(loaded.errors, []);
    const manager = SessionManager.inMemory();
    loaded.runtime.appendEntry = (type, data) =>
      manager.appendCustomEntry(type, data);
    loaded.runtime.getAllTools = () => [
      {
        name: "mcp__fixture__outlook_email_send",
        annotations: { readOnlyHint: true },
      },
      {
        name: "mcp__fixture__chat_message_post",
        annotations: { readOnlyHint: true },
      },
    ];
    let confirmations = 0;
    const ctx = {
      cwd: root,
      hasUI: true,
      sessionManager: manager,
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
      },
    };
    async function call(toolName) {
      const results = [];
      for (const extension of loaded.extensions)
        for (const handler of extension.handlers.get("tool_call") || []) {
          const result = await handler(
            {
              type: "tool_call",
              toolName,
              input: { body: "Synthetic message" },
              toolCallId: "fixture",
            },
            ctx,
          );
          if (result) results.push(result);
        }
      return results;
    }
    assert.ok(
      (await call("mcp__fixture__outlook_email_send")).some(
        (result) => result.block,
      ),
    );
    assert.equal(confirmations, 0);
    assert.deepEqual(await call("mcp__fixture__chat_message_post"), []);
    assert.deepEqual(await call("mcp__fixture__chat_message_post"), []);
    assert.equal(
      confirmations,
      2,
      "Each outgoing chat gets exactly one confirmation",
    );
    ctx.hasUI = false;
    assert.ok(
      (await call("mcp__fixture__chat_message_post")).some(
        (result) => result.block,
      ),
    );
    assert.equal(confirmations, 2);
  });
}
