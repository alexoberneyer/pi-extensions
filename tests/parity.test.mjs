import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(packageDir, "Run with node scripts/test.mjs.");
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": require.resolve("./dist/index.js"),
    "@earendil-works/pi-ai":
      require.resolve("./dist/core/extensions/pi-ai-extension-view.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  },
});
const { commandRisk, pathRisk } = await jiti.import(
  join(root, "extensions/approval/index.ts"),
);
const { memoryFor } = await jiti.import(
  join(root, "extensions/workstation/index.ts"),
);
const { publicUrl, default: webExtension } = await jiti.import(
  join(root, "extensions/web/index.ts"),
);
const { loadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const { SessionManager, DefaultResourceLoader, SettingsManager } = await import(
  pathToFileURL(require.resolve("./dist/index.js"))
);
const policy = { protectedCommands: ["example-cli", "example-internal"] };

function temporary(t) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pi-parity-test-")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(t, config = {}) {
  const home = temporary(t);
  const path = join(home, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const values = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_EXTENSIONS_CONFIG: path,
    SKILL_USAGE_LOG: undefined,
  };
  for (const [name, value] of Object.entries(values)) {
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
async function harness(names) {
  const loaded = await loadExtensions(
    names.map((name) => join(root, "extensions", name, "index.ts")),
    root,
  );
  assert.deepEqual(loaded.errors, []);
  const manager = SessionManager.inMemory();
  loaded.runtime.appendEntry = (type, data) =>
    manager.appendCustomEntry(type, data);
  const notices = [];
  const tools = loaded.extensions.flatMap((extension) =>
    [...extension.tools.values()].map((item) => item.definition ?? item),
  );
  loaded.runtime.getAllTools = () => tools;
  let activeTools = ["read", "bash", "edit", "write"];
  loaded.runtime.getActiveTools = () => activeTools;
  loaded.runtime.setActiveTools = (names) => {
    activeTools = names;
  };
  const ctx = {
    cwd: root,
    mode: "print",
    hasUI: false,
    sessionManager: manager,
    ui: {
      notify: (text) => notices.push(text),
      setStatus() {},
      setWidget() {},
      confirm: async () => false,
    },
  };
  async function emit(type, event = {}) {
    const result = [];
    for (const extension of loaded.extensions)
      for (const handler of extension.handlers.get(type) || []) {
        result.push(await handler({ type, ...event }, ctx));
      }
    return result.filter(Boolean);
  }
  return { loaded, manager, tools, ctx, notices, emit };
}

test("risk checks allow normal inspection and flag production mutations", () => {
  for (const command of [
    "git status",
    "npm run lint:check",
    "example-internal order get 123",
    "example-internal invoicing status 123",
    "example-cli --help",
    "bq query 'SELECT 1'",
  ]) {
    assert.equal(commandRisk(command, policy), undefined, command);
  }
  for (const command of [
    "rm -rf /tmp/data",
    "sudo x",
    "git push origin main",
    "git reset --hard",
    "git clean -fd",
    "example-internal order cancel 123",
    "example-internal customer update 123",
    "example-internal invoicing execute 123",
    "example-cli order create",
    "example-internal new-command 123",
    "example-internal new-command 123 get",
    "example-cli quote --payload data.json",
    "bq query 'DELETE FROM things WHERE id=1'",
    "curl -X POST https://example.com",
    "gh pr merge 42",
  ]) {
    assert.ok(commandRisk(command, policy), command);
  }
  assert.equal(commandRisk("example-cli order create"), undefined);
  assert.ok(pathRisk("/workspace/example/.env"));
  assert.ok(pathRisk("/workspace/example/.pi/agent/auth.json"));
  assert.ok(pathRisk("/workspace/example/.pi/agent/mcp.json"));
  assert.ok(pathRisk("/workspace/example/.git/config"));
  assert.equal(pathRisk("/workspace/example/src/main.ts"), undefined);
});

test("reviewed custom read operations preserve protection through wrappers and the real guard", async (t) => {
  const configured = {
    protectedCommands: ["example-cli"],
    readCommands: ["preview", "execute", "push"],
  };
  assert.equal(commandRisk("example-cli order preview", configured), undefined);
  assert.equal(
    commandRisk("bash -lc 'example-cli order preview'", configured),
    undefined,
  );
  assert.ok(commandRisk("example-cli order preview", policy));
  assert.ok(commandRisk("example-cli order execute", configured));
  assert.ok(commandRisk("git push origin main", configured));
  fixture(t, { approval: configured });
  const h = await harness(["approval"]);
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "bash",
      toolCallId: "read",
      input: { command: "example-cli order preview" },
    }),
    [],
  );
  assert.ok(
    (
      await h.emit("tool_call", {
        toolName: "bash",
        toolCallId: "mutation",
        input: { command: "example-cli order execute" },
      })
    ).some((result) => result.block),
  );
});

const inspectionCommands = [
  "ls -la /workspace/example/tools",
  "find docs lessons example -name AGENTS.md",
  "git check-ignore example/team/data/fixture.md",
  "/workspace/example/api/node_modules/.bin/tsc --noEmit",
  "rg -n -F -- 'git push origin main' src",
  'rg -n -F -- "rm -rf /tmp/data" src',
  "rg -n -F -- 'sudo x' src",
  "rg -n -F -- 'DELETE FROM things' src",
  "grep -F 'example-internal order cancel 123' notes.md",
  "rg -F 'git push; rm -rf /tmp/data | sudo x' src && git status",
  'rg -F "git push\\nrm -rf" src',
  "git log --grep='git push origin main'",
  "git stash push -m 'Save local work'",
  "git -C /workspace/example/api status",
  "env NOTE='git push origin main' rg -F 'DELETE FROM' src",
  "printf '%s\\n' 'git push origin main' 'DELETE FROM things'",
  "# git push origin main\nls example",
  "cat <<'EOF'\ngit push origin main\nrm -rf /tmp/data\nDELETE FROM things\nEOF\ngit status",
  "python3 - <<'PY'\npath = '/workspace/example/api'\nprint(path)\nPY",
  "nice -n 5 rg -F 'git push' src",
  "cat <(printf '%s' 'git push origin main')",
  "printf '%s\\n' 'git push origin main' 'DELETE FROM things;' | cat",
  "(printf '%s\\n' 'git push origin main' 'DELETE FROM things;') | cat",
  "printf '%s\\n' 'git status' | sh",
  "printf '%s\\n' 'SELECT 1;' | psql",
  "cat <<\\EOF\ngit push origin main\nEOF\ngit status",
  'cat <<E"OF"\n$(git push origin main)\nEOF\ngit status',
  "curl -s https://example.com",
  "curl -oXPOST https://example.com",
];

test("risk checks distinguish paths and literal inspection arguments from commands", () => {
  for (const command of inspectionCommands)
    assert.equal(commandRisk(command, policy), undefined, command);
});

test("risk checks retain guarded commands through quoting, composition and shell wrappers", () => {
  for (const command of [
    '/usr/bin/git -C "/workspace/example/api" push origin main',
    '"git" push origin main',
    "g\\it push origin main",
    "git \\\n  push origin main",
    "rg -F 'git push' src; git push origin main",
    "rg -F 'rm -rf' src && rm -rf /tmp/data",
    "env TARGET=main git push origin main",
    "env -u TOKEN /usr/bin/git push origin main",
    "env -S 'git push origin main'",
    "env -S'git push origin main'",
    "env --split-string='git push origin main'",
    "command -- git push origin main",
    "exec git push origin main",
    "nice -n 5 git push origin main",
    "eval 'git push origin main'",
    "if test -d src; then git push origin main; fi",
    'rg -F "$(git push origin main)" src',
    "echo `git push origin main`",
    "(git push origin main) | cat",
    "bash -lc 'git push origin main'",
    "sh -c 'rm -rf /tmp/data'",
    "ssh -o BatchMode=yes example-host 'git push origin main'",
    "ssh example-host \"bash -lc 'bash -s'\" <<'SH'\ngit push origin main\nSH",
    "ssh example-host psql <<'SQL'\nDELETE FROM things;\nSQL",
    "printf '%s\\n' 'git push origin main' | ssh example-host",
    "ssh example-host <<'SH'\ngit push origin main\nSH",
    "node -e \"require('node:child_process').execSync('git push origin main')\"",
    "node --input-type=module <<'JS'\nawait remote('rm -rf /tmp/data');\nJS",
    "python3 -c 'import os; os.system(\"git push origin main\")'",
    "find . -exec rm -rf {} \\;",
    "printf '%s\\n' /tmp/data | xargs -n 1 rm -rf",
    "printf '%s\\n' 'git push origin main' | sh",
    "printf '%s\\n' 'git push origin main' | cat | sh",
    "(printf '%s\\n' 'git push origin main') | sh",
    "(printf '%s\\n' 'DELETE FROM things;') | psql",
    "printf '%s\\n' 'DELETE FROM things;' | psql",
    "echo 'DELETE FROM things;' | bq query",
    "cat <<'SQL' | psql\nDELETE FROM things;\nSQL",
    "bash <<'SH'\ngit push origin main\nSH",
    "bash <<< 'git push origin main'",
    "cat <<EOF\n$(git push origin main)\nEOF",
    "cat <<EOF\n`git push origin main`\nEOF",
    "cat <<'EOF'\nread-only data\nEOF\ngit push origin main",
    "cat <<\\EOF\nliteral\nEOF\ngit push origin main",
    'cat <<E"OF"\nliteral\nEOF\ngit push origin main',
    "cat <<-EOF\n\tliteral\n\tEOF\ngit push origin main",
    "cat <(printf x); git push origin main",
    "cat <(printf x) && git push origin main",
    "cat <(git push origin main)",
    "cat > >(git push origin main)",
    "git push origin main > /tmp/publish.log",
    "> /tmp/publish.log git push origin main",
    "sudo git status",
    "chmod 777 /tmp/data",
    'rm "-rf" /tmp/data',
    "/workspace/example/bin/example-internal order cancel 123",
    "example-internal order cancel 123 | cat",
    "bash -c 'example-cli order create'",
    "ssh example-host 'example-internal order cancel 123'",
    "printf '%s\\n' 'example-cli order create' | sh",
    "kubectl --context production delete pod example",
    "gcloud run deploy example",
    "terraform apply",
    "bq query --use_legacy_sql=false 'DELETE FROM things WHERE id=1'",
    "bq query <<'SQL'\nDELETE FROM things WHERE id=1\nSQL",
    "psql -c 'DROP TABLE things'",
    "gh --repo example/project pr merge 42",
    "curl -X 'POST' https://example.com",
    "curl --request=DELETE https://example.com",
    "curl -XPOST https://example.com",
    "curl -sX POST https://example.com",
    "curl -sXPOST https://example.com",
    "curl -fsSX PATCH https://example.com",
    "curl -qX POST https://example.com",
  ])
    assert.ok(commandRisk(command, policy), command);
});

test("ordinary Bash inspection never opens an approval dialog or blocks headless work", async (t) => {
  fixture(t, { approval: policy });
  const h = await harness(["approval"]);
  h.ctx.ui.confirm = async () => {
    assert.fail("Inspection must not request approval.");
  };
  for (const hasUI of [false, true]) {
    h.ctx.hasUI = hasUI;
    for (const command of inspectionCommands)
      assert.deepEqual(
        await h.emit("tool_call", {
          toolName: "bash",
          input: { command },
          toolCallId: "inspection",
        }),
        [],
        command,
      );
  }
});

test("approval factory applies configured protected commands", async (t) => {
  fixture(t, { approval: policy });
  const h = await harness(["approval"]);
  for (const command of [
    "example-cli order create",
    "example-internal new-command 123",
    "bash -c 'example-internal order cancel 123'",
  ]) {
    const [result] = await h.emit("tool_call", {
      toolName: "bash",
      input: { command },
      toolCallId: "protected",
    });
    assert.equal(result.block, true, command);
  }
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "bash",
      input: { command: "example-internal order get 123" },
      toolCallId: "read-only",
    }),
    [],
  );
});

test("approvals fail closed without UI and respect interactive answers", async () => {
  const h = await harness(["approval"]);
  const event = {
    toolName: "bash",
    input: { command: "git push origin main" },
    toolCallId: "a",
  };
  assert.equal((await h.emit("tool_call", event))[0].block, true);
  assert.deepEqual(
    await h.emit("tool_call", { ...event, input: { command: "git status" } }),
    [],
  );
  h.ctx.hasUI = true;
  assert.equal((await h.emit("tool_call", event))[0].block, true);
  h.ctx.ui.confirm = async () => true;
  assert.deepEqual(await h.emit("tool_call", event), []);
  h.ctx.hasUI = false;
  assert.equal(
    (
      await h.emit("tool_call", {
        toolName: "mcp__example__update",
        input: {},
        toolCallId: "nested",
        parentToolCallId: "outer",
      })
    )[0].block,
    true,
  );
});

test("checklist refreshes preserve publish and cleanup grants, while plan transitions revoke them", async (t) => {
  const cwd = temporary(t),
    remote = join(temporary(t), "origin.git");
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, "file.md"), "fixture\n");
  git("add", "file.md");
  git("commit", "-m", "Fixture");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("branch", "stale");
  git("push", "origin", "main", "stale");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  const h = await harness(["approval", "workflows"]);
  h.ctx.cwd = cwd;
  h.ctx.hasUI = true;
  let prompts = 0;
  h.ctx.ui.confirm = async () => {
    prompts++;
    return false;
  };
  await h.emit("session_start");
  const todo = h.tools.find((tool) => tool.name === "todo");
  const plan = h.loaded.extensions
    .flatMap((extension) => [...extension.commands])
    .find(([name]) => name === "plan")[1];
  const request = () =>
    h.emit("input", {
      source: "interactive",
      text: "please push and delete stale branches",
    });
  const push = () =>
    h.emit("tool_call", {
      toolName: "bash",
      input: { command: "git push origin main" },
      toolCallId: "publish",
    });
  const cleanup = () =>
    h.emit("tool_call", {
      toolName: "bash",
      input: { command: "git push origin --delete stale" },
      toolCallId: "cleanup",
    });
  await request();
  await h.emit("before_agent_start", {
    messageType: "user",
    systemPromptOptions: { sections: {}, promptGuidelines: [] },
  });
  for (const params of [
    { action: "set", tasks: ["Publish requested changes"] },
    { action: "update", step: 1, status: "in-progress" },
    { action: "list" },
    { action: "update", step: 1, status: "done" },
  ])
    await todo.execute("tasks", params, undefined, () => {}, h.ctx);
  await plan.handler("status", h.ctx);
  await plan.handler("off", h.ctx);
  assert.deepEqual(await push(), []);
  assert.deepEqual(await cleanup(), []);
  assert.equal(prompts, 0);
  assert.equal((await push())[0].block, true);
  assert.equal(prompts, 1);

  await request();
  await plan.handler("on", h.ctx);
  assert.equal((await push())[0].block, true);
  assert.equal(prompts, 1, "plan mode blocks without opening a dialog");
  await plan.handler("off", h.ctx);
  assert.equal((await push())[0].block, true);
  assert.equal((await cleanup())[0].block, true);
  assert.equal(prompts, 3, "leaving plan mode must not restore old grants");
});

test("annotated inspections skip approval but destructive or unknown tools stay guarded", async () => {
  const h = await harness(["approval", "workflows"]);
  const reviewed = ["mcp__example__query", "mcp__example__search"];
  const guarded = ["mcp__example__update", "mcp__example__unknown"];
  let prompts = 0;
  h.ctx.ui.confirm = async () => {
    prompts++;
    return false;
  };
  const plan = h.loaded.extensions
    .flatMap((extension) => [...extension.commands])
    .find(([name]) => name === "plan")[1];
  for (const hasUI of [false, true]) {
    h.ctx.hasUI = hasUI;
    for (const planning of [false, true]) {
      await plan.handler(planning ? "on" : "off", h.ctx);
      for (const annotations of [
        { readOnlyHint: true },
        { readOnlyHint: true, destructiveHint: false },
      ]) {
        h.loaded.runtime.getAllTools = () =>
          reviewed.map((name) => ({ name, annotations }));
        for (const toolName of reviewed) {
          const before = prompts;
          assert.deepEqual(
            await h.emit("tool_call", {
              toolName,
              input: {},
              toolCallId: toolName,
            }),
            [],
            toolName,
          );
          assert.equal(prompts, before, "reviewed inspection must not prompt");
        }
      }
      h.loaded.runtime.getAllTools = () =>
        reviewed.map((name) => ({
          name,
          annotations: { readOnlyHint: true, destructiveHint: true },
        }));
      for (const toolName of [...reviewed, ...guarded])
        assert.equal(
          (
            await h.emit("tool_call", {
              toolName,
              input: {},
              toolCallId: toolName,
            })
          )[0].block,
          true,
          `${toolName}: hasUI=${hasUI}, planning=${planning}`,
        );
    }
  }
});

test("subagent dispatch skips approval in interactive and headless modes", async () => {
  const h = await harness(["approval", "workflows"]);
  h.ctx.ui.confirm = async () => {
    assert.fail("Subagent dispatch must not request approval.");
  };
  for (const hasUI of [false, true]) {
    h.ctx.hasUI = hasUI;
    for (const input of [
      { agent: "scout", task: "Inspect files" },
      { tasks: [{ agent: "scout", task: "Inspect files" }] },
      { chain: [{ agent: "scout", task: "Inspect files" }] },
    ]) {
      assert.deepEqual(
        await h.emit("tool_call", {
          toolName: "subagent",
          input,
          toolCallId: "dispatch",
        }),
        [],
      );
    }
  }
});

test("email stays draft-only and each outgoing chat call needs its own confirmation", async () => {
  const h = await harness(["approval", "workflows"]);
  h.ctx.hasUI = true;
  const previews = [];
  h.ctx.ui.confirm = async (title, message) => {
    previews.push({ title, message });
    return true;
  };
  h.loaded.runtime.getAllTools = () => [
    {
      name: "mcp__example__chat_message_post",
      annotations: { readOnlyHint: true },
    },
    {
      name: "mcp__example__email_send",
      annotations: { readOnlyHint: true },
    },
  ];
  const [blocked] = await h.emit("tool_call", {
    toolName: "mcp__example__email_send",
    input: {},
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /draft-only/);
  assert.equal(previews.length, 0);
  for (const body of ["First message", "Second message"])
    await h.emit("tool_call", {
      toolName: "mcp__example__chat_message_post",
      input: { recipient: "fixture", body },
    });
  assert.equal(previews.length, 2);
  assert.match(previews[0].message, /First message/);
  assert.match(previews[1].message, /Second message/);
  const plan = h.loaded.extensions
    .flatMap((extension) => [...extension.commands])
    .find(([name]) => name === "plan")[1];
  await plan.handler("on", h.ctx);
  const [planned] = await h.emit("tool_call", {
    toolName: "mcp__example__chat_message_post",
    input: {},
  });
  assert.equal(planned.block, true);
  assert.equal(previews.length, 2);
});

test("real loader registers plan, todo and the bundled subagent tool", async () => {
  const h = await harness(["approval", "workflows"]);
  assert.ok(h.tools.find((tool) => tool.name === "subagent"));
  const commands = h.loaded.extensions.flatMap((extension) => [
    ...extension.commands,
  ]);
  const plan = commands.find(([name]) => name === "plan")[1];
  await h.emit("session_start");
  await plan.handler("on", h.ctx);
  assert.ok(h.loaded.runtime.getActiveTools().includes("find"));
  for (const toolName of [
    "bash",
    "write",
    "edit",
    "mcp__example__update",
    "subagent",
  ]) {
    assert.ok(
      (
        await h.emit("tool_call", { toolName, input: {}, toolCallId: toolName })
      ).some((result) => result.block),
      toolName,
    );
  }
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "read",
      input: {},
      toolCallId: "read",
    }),
    [],
  );
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "todo",
      input: {},
      toolCallId: "todo",
    }),
    [],
  );
  await plan.handler("off", h.ctx);
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "/workspace/example/main.ts" },
      toolCallId: "edit",
    }),
    [],
  );
  assert.deepEqual(
    await h.emit("tool_call", {
      toolName: "subagent",
      input: { agent: "scout", task: "Inspect files" },
      toolCallId: "subagent",
    }),
    [],
  );
});

test("todo state follows the active session branch", async () => {
  const h = await harness(["workflows"]);
  await h.emit("session_start");
  const tool = h.tools.find((tool) => tool.name === "todo");
  await tool.execute(
    "1",
    { action: "set", tasks: ["Test gate", "Check loading"] },
    undefined,
    undefined,
    h.ctx,
  );
  const leaf = h.manager.getLeafId();
  await tool.execute(
    "2",
    { action: "update", step: 1, status: "done" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.match(
    (await tool.execute("3", { action: "list" }, undefined, undefined, h.ctx))
      .content[0].text,
    /\[done\]/,
  );
  h.manager.branch(leaf);
  await h.emit("session_tree");
  assert.doesNotMatch(
    (await tool.execute("4", { action: "list" }, undefined, undefined, h.ctx))
      .content[0].text,
    /\[done\]/,
  );
});

test("memory lookup is project-scoped, follows cwd symlinks, and does not use a sibling", (t) => {
  const home = temporary(t);
  const project = join(home, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(home, "other"));
  const index = join(
    home,
    ".claude/projects",
    project.replace(/[^a-zA-Z0-9-]/g, "-"),
    "memory/MEMORY.md",
  );
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, "Fixture memory.");
  symlinkSync(project, join(home, "linked"));
  assert.equal(memoryFor(join(project, "src"), home), index);
  assert.equal(memoryFor(join(home, "linked"), home), index);
  assert.equal(memoryFor(join(home, "other"), home), undefined);
});

test("memory lookup accepts an explicit projects root without falling back to another store", (t) => {
  const home = temporary(t);
  const project = join(home, "project");
  const projects = join(home, "memory-store");
  const index = join(
    projects,
    project.replace(/[^a-zA-Z0-9-]/g, "-"),
    "memory/MEMORY.md",
  );
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, "Fixture memory.");
  assert.equal(memoryFor(join(project, "src"), home, projects), index);
  assert.equal(memoryFor(project, home), undefined);
  assert.equal(memoryFor(project, home, join(home, "missing")), undefined);
});

test("workstation defaults do not read context, log usage, discover resources or start hooks", async (t) => {
  const home = fixture(t);
  const previous = process.env.PI_QMD_REFRESH;
  process.env.PI_QMD_REFRESH = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_QMD_REFRESH;
    else process.env.PI_QMD_REFRESH = previous;
  });
  const h = await harness(["workstation"]);
  h.ctx.cwd = join(home, "not-created");
  h.ctx.mode = "tui";
  h.ctx.hasUI = true;
  const noRead = t.mock.method(fs, "readFileSync", () =>
    assert.fail("Default workstation must not read private context."),
  );
  const noLog = t.mock.method(fs, "appendFileSync", () =>
    assert.fail("Default workstation must not write usage logs."),
  );
  const noSpawn = t.mock.method(childProcess, "spawn", () =>
    assert.fail("Default workstation must not start a hook."),
  );
  const noTimer = t.mock.method(globalThis, "setTimeout", () =>
    assert.fail("Default workstation must not schedule a hook."),
  );
  syncBuiltinESMExports();
  try {
    await h.emit("session_start");
    const options = { sections: {}, promptGuidelines: [] };
    await h.emit("before_agent_start", {
      messageType: "user",
      systemPromptOptions: options,
    });
    assert.deepEqual(options, { sections: {}, promptGuidelines: [] });
    assert.deepEqual(
      await h.emit("resources_discover", { reason: "startup", cwd: home }),
      [{ skillPaths: [], promptPaths: [] }],
    );
    await h.emit("input", {
      source: "interactive",
      text: "/example secret-argument",
    });
    await h.emit("tool_call", {
      toolName: "read",
      input: { path: join(home, "skills/example/SKILL.md") },
    });
    await h.emit("session_shutdown");
    for (const mock of [noRead, noLog, noSpawn, noTimer])
      assert.equal(mock.mock.callCount(), 0);
  } finally {
    for (const mock of [noRead, noLog, noSpawn, noTimer]) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("workstation injects configured project context and logs names without arguments", async (t) => {
  const home = fixture(t, {
    workstation: {
      memory: true,
      memoryDirectory: "memory",
      styleFile: "style.md",
      usageLog: "usage.jsonl",
    },
  });
  const project = join(home, "project");
  const index = join(
    home,
    "memory",
    project.replace(/[^a-zA-Z0-9-]/g, "-"),
    "memory/MEMORY.md",
  );
  mkdirSync(project);
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, "Fixture project memory.");
  const style = join(home, "style.md");
  writeFileSync(style, "---\nname: Fixture\n---\nLead with the action.");
  const skill = join(project, "skills/test/SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(
    skill,
    "---\nname: test\ndescription: fixture\n---\nInstructions",
  );
  const h = await harness(["workstation"]);
  writeFileSync(join(home, "config.json"), "{}");
  h.ctx.cwd = project;
  await h.emit("session_start");
  const options = { sections: {}, promptGuidelines: [] };
  await h.emit("before_agent_start", {
    messageType: "user",
    prompt: "request",
    systemPromptOptions: options,
  });
  assert.match(options.sections.workstation_memory, /Fixture project memory/);
  assert.match(
    options.sections.workstation_output_style,
    /Lead with the action/,
  );
  assert.doesNotMatch(
    options.sections.workstation_output_style,
    /name: Fixture/,
  );
  await h.emit("input", {
    source: "interactive",
    text: "/writing:draft secret-argument",
  });
  await h.emit("tool_call", {
    toolName: "read",
    toolCallId: "1",
    input: { path: skill },
  });
  await h.emit("tool_call", {
    toolName: "read",
    toolCallId: "2",
    input: { path: skill, offset: 20 },
  });
  const log = readFileSync(join(home, "usage.jsonl"), "utf8");
  assert.doesNotMatch(
    log,
    /secret-argument|Fixture project memory|Instructions/,
  );
  const entries = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.source === "pi"));
  assert.deepEqual(
    entries.map(({ event, name }) => ({ event, name })),
    [
      { event: "slash", name: "writing:draft" },
      { event: "skill", name: "test" },
    ],
  );
  assert.equal(entries[1].args, null);
  h.ctx.cwd = home;
  await h.emit("before_agent_start", {
    messageType: "user",
    systemPromptOptions: options,
  });
  assert.equal(options.sections.workstation_memory, undefined);
  await h.emit("session_shutdown");
});

test("web URL validation rejects local or credential-bearing destinations", () => {
  assert.equal(
    publicUrl("https://example.com/article"),
    "https://example.com/article",
  );
  for (const url of [
    "file:///etc/passwd",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.0.1",
    "http://[::1]",
    "https://user:password@example.com",
    "http://box.local",
  ]) {
    assert.throws(() => publicUrl(url));
  }
});

test("web search reports missing credentials without a request, fetch uses pinned extractor", async (t) => {
  const home = temporary(t);
  const oldHome = process.env.HOME;
  const oldKey = process.env.BRAVE_API_KEY;
  process.env.HOME = home;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    process.env.HOME = oldHome;
    if (oldKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = oldKey;
  });
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Missing credentials must not make a request."),
  );
  const tools = [];
  const calls = [];
  webExtension({
    registerTool: (tool) => tools.push(tool),
    exec: async (...args) => {
      calls.push(args);
      return { code: 0, killed: false, stdout: "Article text", stderr: "" };
    },
  });
  await assert.rejects(
    tools
      .find((tool) => tool.name === "web_search")
      .execute("1", { query: "test" }),
    /not configured/,
  );
  const result = await tools
    .find((tool) => tool.name === "web_fetch")
    .execute("2", { url: "https://example.com/a" });
  assert.match(result.content[0].text, /Article text/);
  assert.equal(calls[0][0], "uvx");
  assert.ok(calls[0][1].includes("trafilatura==2.2.0"));
});

function resourceFixture(t) {
  const home = fixture(t, {
    workstation: {
      skillPaths: ["skills", "missing-skills"],
      promptPaths: ["prompts", "missing-prompts"],
    },
  });
  for (const name of ["inspect", "draft"]) {
    const skill = join(home, "skills", name, "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(
      skill,
      `---\nname: ${name}\ndescription: Fixture skill\n---\nFixture instructions.\n`,
    );
  }
  mkdirSync(join(home, "prompts"));
  writeFileSync(
    join(home, "prompts", "example:review.md"),
    "---\ndescription: Fixture review\n---\nReview $ARGUMENTS.\n",
  );
  return home;
}

test("workstation resources are parsed as skills and aliases by Pi", async (t) => {
  const home = resourceFixture(t);
  const h = await harness(["workstation"]);
  const [resources] = await h.emit("resources_discover", {
    reason: "startup",
    cwd: home,
  });
  assert.deepEqual(resources, {
    skillPaths: [join(home, "skills")],
    promptPaths: [join(home, "prompts")],
  });
  const loader = new DefaultResourceLoader({
    cwd: home,
    agentDir: join(home, "agent"),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noContextFiles: true,
    additionalSkillPaths: resources.skillPaths,
    additionalPromptTemplatePaths: resources.promptPaths,
  });
  await loader.reload();
  assert.deepEqual(
    loader
      .getSkills()
      .skills.map((skill) => skill.name)
      .sort(),
    ["draft", "inspect"],
  );
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.deepEqual(
    loader.getPrompts().prompts.map((prompt) => prompt.name),
    ["example:review"],
  );
  assert.deepEqual(loader.getPrompts().diagnostics, []);
});

test("real resource discovery loads configured aliases and extensions without a session", async (t) => {
  const home = resourceFixture(t);
  const settingsManager = SettingsManager.inMemory({
    prompts: [join(home, "prompts")],
    extensions: ["approval", "workstation", "workflows", "web"].map((name) =>
      join(root, "extensions", name),
    ),
  });
  const loader = new DefaultResourceLoader({
    cwd: home,
    agentDir: join(home, "agent"),
    settingsManager,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 4);
  assert.deepEqual(
    loader.getPrompts().prompts.map((prompt) => prompt.name),
    ["example:review"],
  );
  assert.deepEqual(loader.getPrompts().diagnostics, []);
});
