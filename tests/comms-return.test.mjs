import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_TEST_PACKAGE_DIR;
const require = createRequire(join(host, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
    "@earendil-works/pi-ai": join(dirname(host), "pi-ai/dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  },
});
const { Store } = await jiti.import(join(root, "extensions/comms/store.ts"));
const { ingest, setDraft } = await jiti.import(
  join(root, "extensions/comms/state.ts"),
);
const { loadExtensions } = await import(
  pathToFileURL(join(host, "dist/core/extensions/loader.js"))
);
const { SessionManager } = await import(
  pathToFileURL(join(host, "dist/index.js"))
);
const { createEventBus } = await import(
  pathToFileURL(join(host, "dist/core/event-bus.js"))
);
const { getThemeByName } = await import(
  pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js"))
);
const { getKeybindings } = await import(
  pathToFileURL(require.resolve("@earendil-works/pi-tui"))
);
const { validateToolArguments } = await import(
  pathToFileURL(join(dirname(host), "pi-ai/dist/index.js"))
);
const prefix = "mcp__claude_ai_Microsoft_365__";
const send = `${prefix}chat_message_send`;
const draft = `${prefix}outlook_create_draft`;
const getMe = `${prefix}get_me`;
const readThread = `${prefix}read_resource`;
const stamp = "2026-10-18T10:00:00.000Z";
const body = "  Exact wording 👋\n\nKeep  two spaces.\n";
const string = { type: "string" };
const metadata = (name, properties, readOnlyHint = false) => ({
  name,
  description: "Synthetic Microsoft 365 fixture",
  exposure: "deferred",
  namespace: { name: "mcp__claude_ai_Microsoft_365" },
  parameters: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
  annotations: { readOnlyHint },
});
const sendMeta = () =>
  metadata(send, { account: string, chat_id: string, body: string });
const draftMeta = () =>
  metadata(draft, {
    account: string,
    to: { type: "array", items: string },
    subject: string,
    body: string,
    content_type: string,
  });
const baseTools = () => [
  sendMeta(),
  draftMeta(),
  metadata(getMe, {}, true),
  metadata(readThread, { uri: string }, true),
];

async function harness(t, options = {}) {
  const directory =
    options.directory || mkdtempSync(join(tmpdir(), "synthetic-return-"));
  if (!options.directory)
    t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const events = createEventBus();
  const loaded = await loadExtensions(
    (options.order || ["comms"]).map((name) =>
      join(root, "extensions", name, "index.ts"),
    ),
    directory,
    events,
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) =>
    entry.commands.has("comms"),
  );
  const manager = SessionManager.inMemory(directory);
  loaded.runtime.appendEntry = (type, data) =>
    manager.appendCustomEntry(type, data);
  const h = {
    directory,
    events,
    loaded,
    manager,
    tools: baseTools(),
    prompts: [],
    notices: [],
    confirmations: [],
    writes: [],
    opened: [],
    editor: "",
    pending: false,
    idle: true,
    confirm: async () => true,
    connector: async () => ({
      isError: false,
      content: [{ type: "text", text: "Synthetic provider success" }],
      details: {},
    }),
    nextChoice: undefined,
    activeTools: ["read", "bash"],
    sessionId: manager.getSessionId(),
  };
  loaded.runtime.getAllTools = () => [
    ...h.tools,
    ...[...extension.tools.values()].map((tool) => tool.definition ?? tool),
  ];
  loaded.runtime.getActiveTools = () => [...h.activeTools];
  loaded.runtime.setActiveTools = (names) => {
    h.activeTools = [...names];
  };
  loaded.runtime.sendUserMessage = (text, opts) =>
    h.prompts.push({ text, opts });
  loaded.runtime.sendMessage = (message, opts) =>
    h.prompts.push({
      text: message.content,
      opts,
      customType: message.customType,
    });
  h.ctx = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    sessionManager: new Proxy(manager, {
      get(target, key) {
        if (key === "getSessionId") return () => h.sessionId;
        return typeof target[key] === "function"
          ? target[key].bind(target)
          : target[key];
      },
    }),
    isIdle: () => h.idle,
    hasPendingMessages: () => h.pending,
    ui: {
      getEditorText: () => h.editor,
      setEditorText: (text) => {
        h.editor = text;
      },
      notify: (text) => h.notices.push(text),
      setStatus() {},
      confirm: async (title, summary) => {
        h.confirmations.push({ title, summary });
        return h.confirm(title, summary);
      },
      onTerminalInput: () => () => {},
      custom: async (factory) => {
        let selected;
        const screen = factory(
          { terminal: { rows: 30, columns: 120 }, requestRender() {} },
          getThemeByName("dark"),
          getKeybindings(),
          (choice) => {
            selected = choice;
          },
        );
        h.opened.push(screen);
        const choice = h.nextChoice;
        h.nextChoice = undefined;
        if (choice) selected = choice;
        return selected;
      },
    },
  };
  h.emit = async (type, event = {}) => {
    if (type === "tool_call") h.currentCall = event;
    for (const ext of loaded.extensions)
      for (const handler of ext.handlers.get(type) || []) {
        const value = await handler({ type, ...event }, h.ctx);
        if (value?.block) return value;
      }
  };
  h.tool = (name) =>
    extension.tools.get(name)?.definition ?? extension.tools.get(name);
  // Synthetic host boundary: nested calls traverse the actual bundled approval
  // and Comms hooks with Pi's documented parent IDs. No connector/network runs.
  h.call = async (name, input, id = "wrapper", parent) => {
    const definition =
      h.tool(name) || h.tools.find((tool) => tool.name === name);
    if (definition) {
      try {
        input = validateToolArguments(definition, {
          type: "toolCall",
          id,
          name,
          arguments: input,
        });
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          details: {},
        };
      }
    }
    const block = await h.emit("tool_call", {
      toolName: name,
      input,
      toolCallId: id,
      parentToolCallId: parent,
    });
    if (block)
      return {
        isError: true,
        content: [{ type: "text", text: block.reason }],
        details: {},
      };
    const local = h.tool(name);
    if (local) {
      const ctx = {
        ...h.ctx,
        tools: h.tools,
        executeTool: async (nestedName, args) => {
          const nested = await h.call(nestedName, args, `${id}/1`, id);
          return {
            toolCall: {
              type: "toolCall",
              id: `${id}/1`,
              name: nestedName,
              arguments: args,
            },
            result: {
              content: nested.content || [],
              details: nested.details || {},
            },
            isError: nested.isError,
            ...(nested.durationMs === undefined
              ? {}
              : { durationMs: nested.durationMs }),
          };
        },
      };
      try {
        return await local.execute(id, input, h.ctx.signal, undefined, ctx);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          details: {},
        };
      }
    }
    const tool = h.tools.find((tool) => tool.name === name);
    if (tool?.annotations.readOnlyHint) {
      await h.emit("tool_result", {
        toolName: name,
        input,
        toolCallId: id,
        isError: false,
        content: [],
      });
      return { isError: false, content: [], details: {} };
    }
    h.writes.push({ name, input, id, parent });
    const outcome = await h.connector(name, input);
    return { ...outcome, durationMs: 0 };
  };
  h.command = extension.commands.get("comms");
  h.queue = new Store(join(directory, "comms"));
  if (!options.directory)
    h.queue.update((state) => {
      ingest(
        state,
        options.source || "teams",
        "me@example.invalid",
        [
          {
            sourceId: "synthetic-message-1",
            sourceUpdatedAt: stamp,
            title: "Synthetic reply request",
            person: "Synthetic colleague",
            summary: "Please review the synthetic proposal.",
            suggestion: "Reply",
            priority: 1,
          },
        ],
        "complete",
        "Synthetic evidence",
        stamp,
      );
      setDraft(state, state.items[0].key, 0, body);
    });
  h.item = () => h.queue.read().items[0];
  h.view = {
    view: 1,
    search: "Synthetic",
    source: options.source || "teams",
    selected: h.item().key,
  };
  h.launch = async (action = "draft-ai") => {
    h.nextChoice = { action, item: h.item(), view: h.view };
    await h.command.handler("", h.ctx);
    const prompt = h.prompts.at(-1)?.text;
    if (prompt && !prompt.startsWith("/comms"))
      await h.emit("before_agent_start", {
        messageType: "custom",
        message: { customType: "comms-selected-action", content: prompt },
        systemPromptOptions: { promptGuidelines: [] },
      });
  };
  h.returnCommand = async () => {
    const message = h.prompts.at(-1);
    assert.match(message.text, /^\/comms return /);
    assert.equal(message.opts.expandPromptTemplates, true);
    await h.command.handler(message.text.slice("/comms ".length), h.ctx);
  };
  return h;
}

test("collection and AI drafting stay read-only and return to the saved view", async (t) => {
  const h = await harness(t);
  const write = {
    account: h.item().account,
    chat_id: "synthetic-thread",
    body: h.item().draft,
  };
  await h.command.handler("refresh pi", h.ctx);
  assert.equal((await h.call(send, write)).isError, true);
  await h.emit("agent_settled", { aborted: false });
  await h.launch();
  assert.equal(h.prompts.at(-1).customType, "comms-selected-action");
  assert.equal((await h.call(send, write)).isError, true);
  assert.equal((await h.call(draft, { ...write, to: [] })).isError, true);
  assert.equal(h.writes.length, 0);
  await h.emit("agent_settled", { aborted: false });
  await h.returnCommand();
  assert.deepEqual(h.opened.at(-1).viewState(), h.view);
});

for (const obstacle of [
  "aborted",
  "input",
  "other-run",
  "pending",
  "editor",
  "plan",
  "session",
  "busy",
  "tree",
  "other-ui",
  "provider-error",
  "user-bash",
]) {
  test(`returning after AI drafting never steals focus after ${obstacle}`, async (t) => {
    const h = await harness(t);
    await h.launch();
    if (obstacle === "input")
      await h.emit("input", {
        source: "interactive",
        text: "Other work",
        streamingBehavior: "steer",
      });
    if (obstacle === "other-run")
      await h.emit("before_agent_start", {
        messageType: "custom",
        systemPromptOptions: { promptGuidelines: [] },
      });
    if (obstacle === "pending") h.pending = true;
    if (obstacle === "editor") h.editor = "Keep my prompt";
    if (obstacle === "plan") {
      h.events.emit("dotfiles:plan-mode", true);
      h.events.emit("dotfiles:plan-mode", false);
    }
    if (obstacle === "session") h.sessionId = "different-session";
    if (obstacle === "busy") h.idle = false;
    if (obstacle === "tree") await h.emit("session_before_tree");
    if (obstacle === "other-ui") await h.emit("ui_prompt_start");
    if (obstacle === "provider-error")
      await h.emit("message_end", {
        message: { role: "assistant", stopReason: "error" },
      });
    if (obstacle === "user-bash") await h.emit("user_bash");
    await h.emit("agent_settled", { aborted: obstacle === "aborted" });
    assert.equal(h.prompts.length, 1);
    assert.equal(h.opened.length, 1);
  });
}

test("deferred return rechecks pending input, and stale internal return tokens never open the queue", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.emit("agent_settled", { aborted: false });
  h.editor = "Typed after settlement";
  await h.returnCommand();
  assert.equal(h.opened.length, 1);
  h.editor = "";
  await h.returnCommand();
  assert.equal(h.opened.length, 1);
});

test("a new run invalidates an already deferred queue return", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.emit("agent_settled", { aborted: false });
  await h.emit("before_agent_start", {
    messageType: "custom",
    systemPromptOptions: { promptGuidelines: [] },
  });
  await h.returnCommand();
  assert.equal(h.opened.length, 1);
});

test("an AI draft saved through the selected-item tool records its origin", async (t) => {
  const h = await harness(t);
  const before = h.item();
  assert.equal(before.draftOrigin, "manual");
  await h.launch();
  const saved = await h.call("comms_save_draft", {
    key: before.key,
    expectedRevision: before.draftRevision,
    draft: "AI-prepared synthetic reply",
  });
  assert.equal(saved.isError, undefined);
  assert.equal(h.item().draft, "AI-prepared synthetic reply");
  assert.equal(h.item().draftOrigin, "ai");
  assert.equal(h.writes.length, 0);
});
