import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
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
const { ReplyJob, replyOperation, replyRead, validateReplyPayload } =
  await jiti.import(join(root, "extensions/comms/reply.ts"));
const { loadExtensions } = await import(
  pathToFileURL(join(host, "dist/core/extensions/loader.js"))
);
const { SessionManager, AgentSession } = await import(
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
    options.directory || mkdtempSync(join(tmpdir(), "synthetic-reply-"));
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
    view: 4,
    search: "Synthetic",
    source: options.source || "teams",
    selected: h.item().key,
    task: undefined,
  };
  h.launch = async (action = "handoff") => {
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
  h.verify = async () => {
    await h.call(getMe, {}, "identity-read");
    await h.call(readThread, { uri: "synthetic-thread" }, "thread-read");
  };
  h.args = (overrides = {}) => {
    const item = h.item();
    return {
      key: item.key,
      expectedRevision: item.draftRevision,
      verified: {
        account: item.account,
        sourceId: item.sourceId,
        sourceUpdatedAt: item.sourceUpdatedAt,
        threadId: "synthetic-thread",
        recipients: ["colleague@example.invalid"],
        readCallIds: ["identity-read", "thread-read"],
      },
      writeTool: item.source === "mail" ? draft : send,
      writeInput:
        item.source === "mail"
          ? {
              account: item.account,
              to: ["colleague@example.invalid"],
              subject: "Re: Synthetic request",
              body: item.draft,
              content_type: "text",
            }
          : {
              account: item.account,
              chat_id: "synthetic-thread",
              body: item.draft,
            },
      ...overrides,
    };
  };
  h.returnCommand = async () => {
    const message = h.prompts.at(-1);
    assert.match(message.text, /^\/comms return /);
    assert.equal(message.opts.expandPromptTemplates, true);
    await h.command.handler(message.text.slice("/comms ".length), h.ctx);
  };
  return h;
}

for (const order of [["comms"], ["approval", "comms"], ["comms", "approval"]]) {
  test(`${order.join(" + ")}: one immediate wrapper job, one exact confirmation and nested write`, async (t) => {
    const h = await harness(t, { order });
    await h.emit("session_start");
    assert.equal(h.tool("comms_deliver_reply").defaultActive, false);
    assert.equal(h.tool("comms_deliver_reply").exposure, "model-only");
    assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
    assert.equal(h.confirmations.length, 0);
    await h.launch();
    assert.equal(h.editor, "");
    assert.equal(h.prompts.length, 1);
    assert.ok(h.activeTools.includes("comms_deliver_reply"));
    await h.verify();
    const result = await h.call("comms_deliver_reply", h.args());
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].parent, "wrapper");
    assert.equal(h.writes[0].input.body, body);
    assert.equal(h.confirmations.length, 1);
    assert.deepEqual(
      JSON.parse(h.confirmations[0].summary.split("\n\n")[1]),
      h.args().writeInput,
    );
    assert.equal(h.item().status, "open");
    assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
    assert.equal(h.writes.length, 1);
    await h.emit("agent_settled", { aborted: false });
    await h.returnCommand();
    assert.deepEqual(h.opened.at(-1).viewState(), h.view);
    assert.equal(h.activeTools.includes("comms_deliver_reply"), false);
    const receipt = readdirSync(h.queue.directory).find((name) =>
      name.startsWith("reply-"),
    );
    assert.match(
      readFileSync(join(h.queue.directory, receipt), "utf8"),
      /tool-reported-success/,
    );
  });
}

test("custom dispatch enters the real host run-finally cleanup even when model startup throws", async (t) => {
  for (const action of ["handoff", "draft-ai"]) {
    const h = await harness(t);
    let dispatch;
    const fakeSession = {
      isStreaming: false,
      _isEmittingAgentSettled: false,
      _pendingToolNames: new Set(),
      _prepareRun: async (trigger) => {
        await h.emit("before_agent_start", trigger);
        return [];
      },
      _flushPendingBashMessages() {},
      _flushPendingCustomMessages() {},
      _recordSelection() {},
      _emitAgentSettled: () => h.emit("agent_settled", { aborted: true }),
      agent: {
        prompt: async () => {
          throw new Error("Synthetic missing model/auth");
        },
      },
    };
    fakeSession._startRun = AgentSession.prototype._startRun.bind(fakeSession);
    h.loaded.runtime.sendMessage = (message, opts) => {
      dispatch = AgentSession.prototype.sendCustomMessage
        .call(fakeSession, message, opts)
        .catch((error) => assert.match(error.message, /missing model\/auth/));
    };
    h.nextChoice = { action, item: h.item(), view: h.view };
    await h.command.handler("", h.ctx);
    await dispatch;
    assert.equal(h.activeTools.includes("comms_deliver_reply"), false);
    assert.equal(h.activeTools.includes("comms_save_draft"), false);
    assert.equal(
      readdirSync(h.queue.directory).some((name) => name.startsWith("reply-")),
      false,
    );
    const other = await harness(t, { directory: h.directory });
    await other.launch();
    assert.equal(other.prompts.length, 1);
    await other.emit("session_shutdown");
  }
});

test("mail creates an approved Outlook draft only, never email-send or a Teams write", async (t) => {
  const h = await harness(t, { source: "mail" });
  await h.launch();
  await h.verify();
  assert.equal(
    (await h.call("comms_deliver_reply", h.args({ writeTool: send }))).isError,
    true,
  );
  const args = h.args({ writeTool: `${prefix}outlook_email_send` });
  assert.equal((await h.call("comms_deliver_reply", args)).isError, true);
  assert.equal((await h.call(`${prefix}outlook_email_send`, {})).isError, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.confirmations.length, 0);
  const wrongRecipient = h.args();
  wrongRecipient.writeInput.to = ["other@example.invalid"];
  assert.equal(
    (await h.call("comms_deliver_reply", wrongRecipient)).isError,
    true,
  );
  const result = await h.call("comms_deliver_reply", h.args());
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /email was not sent/);
  assert.equal(h.writes[0].name, draft);
  assert.equal(h.confirmations.length, 1);
});

test("collection and AI drafting keep their existing read-only boundary; reply wrapper inactive", async (t) => {
  const h = await harness(t);
  await h.command.handler("refresh pi", h.ctx);
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
  assert.equal((await h.call(send, h.args().writeInput)).isError, true);
  assert.equal(h.writes.length, 0);
  await h.emit("agent_settled", { aborted: false });
  await h.launch("draft-ai");
  assert.equal((await h.call(draft, h.args().writeInput)).isError, true);
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
  await h.emit("agent_settled", { aborted: false });
  await h.returnCommand();
  assert.deepEqual(h.opened.at(-1).viewState(), h.view);
});

test("fresh successful provider reads are required, not stale/failed/unrelated reads", async (t) => {
  const h = await harness(t);
  await h.call(getMe, {}, "identity-read");
  await h.launch();
  await h.emit("tool_result", {
    toolName: readThread,
    toolCallId: "thread-read",
    isError: true,
  });
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
  assert.equal(h.confirmations.length, 0);
  await h.verify();
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, false);
});

test("direct and nested writes, including falsely read-only writes, cannot bypass the wrapper", async (t) => {
  const h = await harness(t);
  const liar = metadata(`${prefix}outlookCreateDraft`, { body: string }, true);
  h.tools.push(liar);
  await h.launch();
  for (const [name, parent, input] of [
    [send, undefined, h.args().writeInput],
    [
      draft,
      "codemode",
      {
        account: h.item().account,
        to: ["colleague@example.invalid"],
        subject: "Synthetic",
        body,
        content_type: "text",
      },
    ],
    [liar.name, "codemode", { body }],
    ["bash", undefined, { command: "synthetic-noop" }],
    ["write", undefined, { path: "synthetic.txt", content: body }],
  ]) {
    const blocked = await h.call(name, input, "forbidden", parent);
    assert.equal(blocked.isError, true, name);
    assert.match(blocked.content[0].text, /Reply jobs block/);
  }
  assert.equal(
    (
      await h.call(
        "comms_deliver_reply",
        h.args(),
        "nested-wrapper",
        "codemode",
      )
    ).isError,
    true,
  );
  assert.equal(h.writes.length, 0);
  h.tools[1].annotations.readOnlyHint = true;
  assert.equal(replyOperation(h.tools[1]), undefined);
  assert.equal(replyRead(liar.name, liar), false);
});

test("exact saved text, revision, account, source timestamp, thread, recipients and schema are bound", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.verify();
  const mutations = [
    (a) => {
      a.writeInput.body = body.trim();
    },
    (a) => {
      a.expectedRevision++;
    },
    (a) => {
      a.verified.account = "other@example.invalid";
    },
    (a) => {
      a.verified.sourceId = "another-message";
    },
    (a) => {
      a.verified.sourceUpdatedAt = "2026-10-18T11:00:00.000Z";
    },
    (a) => {
      a.writeInput.chat_id = "other-thread";
    },
    (a) => {
      a.writeInput.account = "other@example.invalid";
    },
    (a) => {
      a.writeInput.recipients = ["other@example.invalid"];
    },
    (a) => {
      a.writeInput.hidden_command = "synthetic";
    },
    (a) => {
      a.writeInput.body = { content: body, contentType: "HTML" };
    },
  ];
  for (const change of mutations) {
    const args = h.args();
    change(args);
    assert.equal((await h.call("comms_deliver_reply", args)).isError, true);
  }
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.writes.length, 0);
});

for (const change of [
  "draft",
  "status",
  "source",
  "payload",
  "metadata",
  "plan",
  "shutdown",
  "pending",
  "editor",
  "abort",
]) {
  test(`rechecks ${change} after the one final approval, before nested write`, async (t) => {
    const h = await harness(t);
    await h.launch();
    await h.verify();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    h.confirm = async () => {
      if (["draft", "status", "source"].includes(change))
        h.queue.update((state) => {
          const item = state.items[0];
          if (change === "draft")
            setDraft(
              state,
              item.key,
              item.draftRevision,
              "Edited while confirming",
            );
          if (change === "status") item.status = "resolved";
          if (change === "source")
            item.sourceUpdatedAt = "2026-10-18T11:00:00.000Z";
        });
      if (change === "payload")
        h.currentCall.input.body = "Changed after approval";
      if (change === "metadata") h.tools[0].annotations.readOnlyHint = true;
      if (change === "plan") {
        h.events.emit("dotfiles:plan-mode", true);
        h.events.emit("dotfiles:plan-mode", false);
      }
      if (change === "shutdown") {
        await h.emit("session_shutdown");
        await h.emit("session_start");
      }
      if (change === "pending") h.pending = true;
      if (change === "editor") h.editor = "Do not steal this";
      if (change === "abort") controller.abort();
      return true;
    };
    const result = await h.call("comms_deliver_reply", h.args());
    assert.equal(result.isError, true);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.writes.length, 0);
    assert.match(result.content[0].text, /not executed|not confirmed|unknown/);
  });
}

for (const outcome of ["denied", "error", "throw", "unknown", "aborted"]) {
  test(`${outcome} consumes authorization; only proven pre-execution failures release the duplicate barrier`, async (t) => {
    const h = await harness(t);
    await h.launch();
    await h.verify();
    if (outcome === "denied") h.confirm = async () => false;
    h.connector = async () => {
      if (outcome === "throw") throw new Error("Synthetic transport lost");
      if (outcome === "error") return { isError: true, content: [] };
      if (outcome === "unknown") return { content: [] };
      if (outcome === "aborted") {
        const c = new AbortController();
        h.ctx.signal = c.signal;
        c.abort();
        return { isError: true, content: [] };
      }
    };
    const result = await h.call("comms_deliver_reply", h.args());
    assert.equal(result.isError, true);
    assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
    assert.equal(h.confirmations.length, 1);
    assert.ok(h.writes.length <= 1);
    await h.emit("agent_settled", { aborted: true });
    const other = await harness(t, { directory: h.directory });
    await other.launch();
    assert.equal(other.prompts.length, outcome === "denied" ? 1 : 0);
    assert.equal(other.writes.length, 0);
    if (outcome === "denied") {
      assert.equal(result.details.outcome, "not-executed");
      await other.emit("session_shutdown");
    } else {
      assert.ok(other.opened.length > 1); // Uncertain results return to the local view.
    }
  });
}

test("successful receipts block the same reply across revision round trips, but permit new wording", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.verify();
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, false);
  await h.emit("agent_settled", { aborted: true });

  const other = await harness(t, { directory: h.directory });
  await other.launch();
  assert.equal(other.prompts.length, 0);
  assert.equal(
    readdirSync(h.queue.directory).filter((name) => name.endsWith(".lock"))
      .length,
    0,
  );
  other.queue.update((state) =>
    setDraft(state, state.items[0].key, state.items[0].draftRevision, body),
  );
  await other.launch();
  assert.equal(other.prompts.length, 0);
  other.queue.update((state) =>
    setDraft(
      state,
      state.items[0].key,
      state.items[0].draftRevision,
      "A separately reviewed follow-up.",
    ),
  );
  await other.launch();
  assert.equal(other.prompts.length, 1);
  await other.verify();
  assert.equal(
    (await other.call("comms_deliver_reply", other.args())).isError,
    false,
  );
  assert.equal(other.writes.length, 1);
  assert.equal(
    readdirSync(h.queue.directory).filter((name) => name.endsWith(".jsonl"))
      .length,
    2,
  );
  await other.emit("session_shutdown");
});

test("uncertain execution blocks new wording too, not only the original reply", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.verify();
  h.connector = async () => ({ isError: true, content: [] });
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
  await h.emit("agent_settled", { aborted: true });
  const other = await harness(t, { directory: h.directory });
  other.queue.update((state) =>
    setDraft(
      state,
      state.items[0].key,
      state.items[0].draftRevision,
      "New wording cannot bypass an uncertain send.",
    ),
  );
  await other.launch();
  assert.equal(other.prompts.length, 0);
  assert.equal(other.writes.length, 0);
});

test("overlapping sessions share an item lock, released only if no delivery was attempted", async (t) => {
  const a = await harness(t);
  await a.launch();
  const b = await harness(t, { directory: a.directory });
  await b.launch();
  assert.equal(b.prompts.length, 0);
  await a.emit("agent_settled", { aborted: true });
  assert.equal(
    readdirSync(a.queue.directory).some((name) => name.startsWith("reply-")),
    false,
  );
  await b.launch();
  assert.equal(b.prompts.length, 1);
  await b.emit("session_shutdown");
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
  test(`normal return never steals focus after ${obstacle}`, async (t) => {
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

test("no supported connector falls back to local text without a model, setup or editor handoff", async (t) => {
  const h = await harness(t);
  h.tools = [];
  await h.launch();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.editor, "");
  assert.equal(h.item().draft, body);
  assert.equal(
    readdirSync(h.queue.directory).some((name) => name.startsWith("reply-")),
    false,
  );
  for (const name of [
    "mcp__unreviewed__chat_message_send",
    `${prefix}outlook_send_mail`,
    `${prefix}chat_message_create`,
  ])
    assert.equal(replyOperation(metadata(name, {})), undefined);
});

test("payload helper supports chat post spelling and plain-text Graph bodies; rejects HTML and unknown formats", async (t) => {
  const h = await harness(t);
  const args = h.args();
  args.writeTool = `${prefix}chat_message_post`;
  const tool = metadata(args.writeTool, {
    account: string,
    chat_id: string,
    body: { type: "object" },
  });
  args.writeInput.body = { content: body, contentType: "Text" };
  assert.equal(replyOperation(tool), "chat_message_post");
  assert.doesNotThrow(() => validateReplyPayload(h.item(), args, tool));
  args.writeInput.body.contentType = "HTML";
  assert.throws(() => validateReplyPayload(h.item(), args, tool), /EXACT/);
});

test("headless delivery remains approval-blocked and consumes its one attempt", async (t) => {
  const h = await harness(t);
  await h.launch();
  await h.verify();
  h.ctx.hasUI = false;
  const result = await h.call("comms_deliver_reply", h.args());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no UI is available/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
});

test("a mail write claiming read-only cannot skip confirmation, and unsupported required schemas stay local", async (t) => {
  const h = await harness(t, { source: "mail" });
  h.tools.find((tool) => tool.name === draft).annotations.readOnlyHint = true;
  await h.launch();
  assert.equal(h.prompts.length, 0);
  h.tools.find((tool) => tool.name === draft).annotations.readOnlyHint = false;
  await h.launch();
  await h.verify();
  h.tools
    .find((tool) => tool.name === draft)
    .parameters.required.push("unsupported_selector");
  const result = await h.call("comms_deliver_reply", h.args());
  assert.equal(result.isError, true);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.call("comms_deliver_reply", h.args())).isError, true);
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

test("reply budget/expiry and item changes revoke writes; abandoned claims fail closed", async (t) => {
  const h = await harness(t);
  const job = new ReplyJob(h.queue, h.item(), h.sessionId);
  assert.ok(existsSync(job.receipt));
  job.calls = 33;
  const pi = { events: h.events };
  assert.throws(() => job.check(h.ctx, pi), /expired/);
  job.calls = 0;
  Object.defineProperty(job, "startedAt", {
    value: Date.now() - 6 * 60 * 1000,
  });
  assert.throws(() => job.check(h.ctx, pi), /expired/);
  assert.throws(
    () => new ReplyJob(h.queue, h.item(), "other-session"),
    /reply claim/,
  );
  job.finish();
  assert.equal(existsSync(job.receipt), false);
});
