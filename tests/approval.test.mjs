import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(
  packageDir,
  "Run through node scripts/test.mjs or set PI_TEST_PACKAGE_DIR.",
);
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
  },
});
const { default: approval, commandRisk } = await jiti.import(
  new URL("../extensions/approval/index.ts", import.meta.url).pathname,
);
const { publishRequest, pushInvocation } = await jiti.import(
  new URL("../extensions/approval/publish.ts", import.meta.url).pathname,
);
const { appendAudit } = await jiti.import(
  new URL("../extensions/approval/audit.ts", import.meta.url).pathname,
);
const { approvalStatus, APPROVAL_QUERY, APPROVAL_READY } = await jiti.import(
  new URL("../extensions/approval/ready.ts", import.meta.url).pathname,
);
const { loadExtensions } = await import(
  join(packageDir, "dist/core/extensions/loader.js")
);
const { SessionManager, createEventBus } = await import(
  join(packageDir, "dist/index.js")
);

function temporary(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "approval-test-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function repo(t) {
  const cwd = temporary(t);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, "file.md"), "fixture\n");
  git(cwd, "add", "file.md");
  git(cwd, "commit", "-m", "Fixture");
  git(cwd, "remote", "add", "origin", "https://example.invalid/fixture.git");
  git(
    cwd,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  return cwd;
}
function remoteRepo(t) {
  const cwd = repo(t);
  const remote = join(temporary(t), "origin.git");
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "set-url", "origin", remote);
  git(cwd, "push", "origin", "main");
  return { cwd, remote };
}
function staleBranch(cwd, branch = "stale") {
  git(cwd, "branch", branch);
  git(cwd, "push", "origin", branch);
  return git(cwd, "rev-parse", branch);
}
function worktree(t, cwd) {
  const checkout = join(temporary(t), "checkout");
  git(cwd, "worktree", "add", "-b", "feature", checkout);
  return checkout;
}
function harness(cwd) {
  const handlers = new Map(),
    records = [],
    prompts = [],
    calls = [],
    manager = SessionManager.inMemory();
  const pi = {
    on: (name, fn) => {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
    },
    events: createEventBus(),
    registerCommand() {},
    getAllTools: () => [],
    appendEntry: (name, data) => {
      records.push({ name, ...data });
      manager.appendCustomEntry(name, data);
    },
  };
  approval(pi);
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    ui: {
      confirm: async (title, body) => {
        prompts.push({ title, body });
        return false;
      },
    },
  };
  let next = 0;
  const emit = async (name, event = {}) => {
    const output = [];
    for (const fn of handlers.get(name) || []) {
      const result = await fn(event, ctx);
      if (result) output.push(result);
    }
    return output;
  };
  const request = (
    text = "please commit, merge if necessary, push, pull and delete stale branches. thanks!",
    extra = {},
  ) => emit("input", { source: "interactive", text, ...extra });
  const call = (command, extra = {}) => {
    const event = {
      toolName: "bash",
      input: { command },
      toolCallId: `call-${++next}`,
      ...extra,
    };
    calls.push(event);
    return emit("tool_call", event);
  };
  function edit(path, id = "edit-1", isError = false) {
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "edit", arguments: { path } }],
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "edit",
      isError,
      content: [],
      timestamp: Date.now(),
    });
  }
  return {
    pi,
    ctx,
    records,
    prompts,
    calls,
    manager,
    emit,
    request,
    call,
    edit,
  };
}

for (const text of [
  "please push",
  "Push it.",
  "Could you please commit and push?",
  "yes, please commit and push. thanks!",
  "Yes. Could you please commit and push?",
  "great, yes, please push to main. thanks!",
  "nice, please commit, merge if necessary, push, pull and delete stale branches. thanks!",
  "commit then push",
  "please push to Release",
  "please delete stale branches",
])
  test(`recognizes direct request: ${text}`, () =>
    assert.ok(publishRequest(text)));
for (const text of [
  "don't push",
  "do not push",
  "never push",
  "please don't push",
  "yes, please don't push",
  "yes, please push only if tests pass",
  "yes, should we push?",
  "yes, push?",
  "yes, explain why git push asks permission",
  "yes, the README says 'please push'",
  "please push only if tests pass",
  "should we push?",
  "push?",
  "explain why git push asks permission",
  "write a message saying please push",
  "the README says 'please push'",
  "push --force",
  "push and delete production",
  "push, push",
  "how many times did we push?",
  "please make the updates",
  "git push origin main && rm -rf /repo",
])
  test(`does not infer authorization from prose: ${text}`, () =>
    assert.equal(publishRequest(text), undefined));

test("one direct request permits exactly one ordinary origin push", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  assert.deepEqual(await h.call("git push origin main"), []);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.records.at(-1).outcome, "explicit-request");
  assert.equal((await h.call("git push origin main"))[0].block, true);
  assert.equal(h.prompts.length, 1);
});

for (const options of [
  ["-u", "origin", "main"],
  ["--set-upstream", "origin", "main"],
  ["origin", "-u", "main"],
  ["origin", "main", "--set-upstream"],
  ["-u", "origin", "HEAD:main"],
])
  test(`upstream push preserves pinned publication and tracking: ${options.join(" ")}`, async (t) => {
    const { cwd, remote } = remoteRepo(t),
      h = harness(cwd);
    writeFileSync(join(cwd, "file.md"), "approved\n");
    git(cwd, "commit", "-am", "Approved change");
    const approved = git(cwd, "rev-parse", "HEAD");
    await h.request("yes, please push");
    assert.deepEqual(await h.call(["git", "push", ...options].join(" ")), []);
    assert.equal(h.prompts.length, 0);
    const command = h.calls.at(-1).input.command;
    writeFileSync(join(cwd, "file.md"), "later unrelated change\n");
    git(cwd, "commit", "-am", "Later change");
    execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
    assert.equal(git(remote, "rev-parse", "main"), approved);
    assert.equal(git(cwd, "rev-parse", "origin/main"), approved);
    assert.equal(git(cwd, "config", "--get", "branch.main.remote"), "origin");
    assert.equal(
      git(cwd, "config", "--get-all", "branch.main.merge"),
      "refs/heads/main",
    );
    assert.equal((await h.call("git push -u origin main"))[0].block, true);
  });

for (const mode of ["never", "local", "remote", "always"])
  test(`first push from a linked worktree honors native autoSetupRebase=${mode}`, async (t) => {
    const { cwd: main, remote } = remoteRepo(t),
      feature = worktree(t, main),
      h = harness(feature);
    git(main, "config", "branch.autoSetupRebase", mode);
    await h.request("please push");
    assert.deepEqual(await h.call("git push -u origin feature"), []);
    execFileSync("sh", ["-c", h.calls.at(-1).input.command], {
      cwd: feature,
      stdio: "pipe",
    });
    assert.equal(
      git(remote, "rev-parse", "feature"),
      git(feature, "rev-parse", "HEAD"),
    );
    assert.equal(
      git(feature, "rev-parse", "--symbolic-full-name", "feature@{upstream}"),
      "refs/remotes/origin/feature",
    );
    if (["remote", "always"].includes(mode))
      assert.equal(
        git(feature, "config", "--get", "branch.feature.rebase"),
        "true",
      );
    else
      assert.throws(() =>
        git(feature, "config", "--get", "branch.feature.rebase"),
      );
  });

test("already up-to-date pushes still establish upstream", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  await h.request("please push");
  assert.deepEqual(await h.call("git push -u origin main"), []);
  execFileSync("sh", ["-c", h.calls.at(-1).input.command], {
    cwd,
    stdio: "pipe",
  });
  assert.equal(
    git(cwd, "rev-parse", "--symbolic-full-name", "main@{upstream}"),
    "refs/remotes/origin/main",
  );
});

test("rejected upstream pushes do not change tracking configuration", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd),
    original = git(cwd, "rev-parse", "origin/main");
  writeFileSync(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(remote, "hooks/pre-receive"), 0o700);
  writeFileSync(join(cwd, "file.md"), "rejected\n");
  git(cwd, "commit", "-am", "Rejected change");
  await h.request("please push");
  assert.deepEqual(await h.call("git push -u origin main"), []);
  assert.throws(() =>
    execFileSync("sh", ["-c", h.calls.at(-1).input.command], {
      cwd,
      stdio: "pipe",
    }),
  );
  assert.equal(git(remote, "rev-parse", "main"), original);
  assert.equal(git(cwd, "rev-parse", "origin/main"), original);
  assert.throws(() => git(cwd, "config", "--get", "branch.main.remote"));
});

for (const drift of ["tracking", "symbolic", "remote", "configuration"])
  test(`upstream bookkeeping detects ${drift} drift without republishing`, async (t) => {
    const { cwd, remote } = remoteRepo(t),
      h = harness(cwd);
    writeFileSync(join(cwd, "file.md"), "approved\n");
    git(cwd, "commit", "-am", "Approved change");
    const approved = git(cwd, "rev-parse", "HEAD");
    await h.request("please push");
    assert.deepEqual(await h.call("git push -u origin main"), []);
    const command = h.calls.at(-1).input.command;
    if (drift === "tracking") {
      writeFileSync(join(cwd, "file.md"), "newer fetch\n");
      git(cwd, "commit", "-am", "Later change");
      git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    } else if (drift === "symbolic") {
      git(
        cwd,
        "update-ref",
        "refs/remotes/origin/same-tip",
        git(cwd, "rev-parse", "origin/main"),
      );
      git(
        cwd,
        "symbolic-ref",
        "refs/remotes/origin/main",
        "refs/remotes/origin/same-tip",
      );
    } else if (drift === "remote") {
      git(
        cwd,
        "remote",
        "set-url",
        "origin",
        "https://example.invalid/changed.git",
      );
    } else git(cwd, "config", "branch.main.remote", "another-remote");
    assert.throws(
      () => execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" }),
      (error) =>
        String(error.stderr).includes(
          "Push succeeded. Upstream setup did not complete.",
        ),
    );
    assert.equal(git(remote, "rev-parse", "main"), approved);
    if (drift === "tracking")
      assert.equal(
        git(cwd, "rev-parse", "origin/main"),
        git(cwd, "rev-parse", "HEAD"),
      );
    if (drift === "symbolic")
      assert.equal(
        git(cwd, "symbolic-ref", "refs/remotes/origin/main"),
        "refs/remotes/origin/same-tip",
      );
    if (drift === "configuration")
      assert.equal(
        git(cwd, "config", "--get", "branch.main.remote"),
        "another-remote",
      );
    else assert.throws(() => git(cwd, "config", "--get", "branch.main.remote"));
  });

test("configuration changes from tracking-ref hooks are preserved", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  writeFileSync(join(cwd, "file.md"), "approved\n");
  git(cwd, "commit", "-am", "Approved change");
  const approved = git(cwd, "rev-parse", "HEAD");
  await h.request("please push");
  assert.deepEqual(await h.call("git push -u origin main"), []);
  const hook = join(cwd, ".git/hooks/reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh
if [ "$1" = prepared ]; then
  while read old new ref; do
    if [ "$ref" = refs/remotes/origin/main ]; then
      git config --local branch.main.remote concurrent
    fi
  done
fi
`,
  );
  chmodSync(hook, 0o700);
  assert.throws(
    () =>
      execFileSync("sh", ["-c", h.calls.at(-1).input.command], {
        cwd,
        stdio: "pipe",
      }),
    (error) =>
      String(error.stderr).includes(
        "Push succeeded. Upstream setup did not complete.",
      ),
  );
  assert.equal(git(remote, "rev-parse", "main"), approved);
  assert.equal(git(cwd, "config", "--get", "branch.main.remote"), "concurrent");
});

test("tracking-ref hooks cannot redirect upstream to another branch", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  writeFileSync(join(cwd, "file.md"), "approved\n");
  git(cwd, "commit", "-am", "Approved change");
  const approved = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/remotes/origin/other", approved);
  await h.request("please push");
  assert.deepEqual(await h.call("git push -u origin main"), []);
  const hook = join(cwd, ".git/hooks/reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh
if [ "$1" = committed ]; then
  while read old new ref; do
    if [ "$ref" = refs/remotes/origin/main ]; then
      git -c core.hooksPath=/dev/null symbolic-ref refs/remotes/origin/main refs/remotes/origin/other
    fi
  done
fi
`,
  );
  chmodSync(hook, 0o700);
  assert.throws(
    () =>
      execFileSync("sh", ["-c", h.calls.at(-1).input.command], {
        cwd,
        stdio: "pipe",
      }),
    (error) =>
      String(error.stderr).includes(
        "Push succeeded. Upstream setup did not complete.",
      ),
  );
  assert.equal(git(remote, "rev-parse", "main"), approved);
  assert.equal(
    git(cwd, "symbolic-ref", "refs/remotes/origin/main"),
    "refs/remotes/origin/other",
  );
  assert.throws(() => git(cwd, "config", "--get", "branch.main.remote"));
});

test("unusual tracking mappings and worktree overrides retain confirmation for upstream setup", async (t) => {
  const main = repo(t),
    feature = worktree(t, main);
  git(main, "config", "extensions.worktreeConfig", "true");
  git(feature, "config", "--worktree", "branch.feature.remote", "other");
  const h = harness(feature);
  await h.request("please push");
  assert.equal((await h.call("git push -u origin feature"))[0].block, true);
  git(main, "config", "remote.origin.fetch", "+refs/heads/*:refs/custom/*");
  const other = harness(main);
  await other.request("please push");
  assert.equal((await other.call("git push -u origin main"))[0].block, true);
});

test("compound publishing retains confirmation, while a standalone push uses the grant", async (t) => {
  const cwd = repo(t),
    h = harness("/unrelated");
  h.edit(join(cwd, "file.md"));
  await h.request();
  const command = `cd '${cwd}' && git fetch origin && git merge-base --is-ancestor origin/main HEAD && git push origin main && git status --short --branch && git ls-remote origin refs/heads/main`;
  assert.equal((await h.call(command))[0].block, true);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await h.call(`git -C '${cwd}' push origin main`), []);
});

test("a successful preceding edit scopes a request to its actual repository, not the chat cwd", async (t) => {
  const cwd = repo(t),
    other = repo(t),
    h = harness(other);
  h.edit(join(cwd, "file.md"));
  await h.request("please push");
  assert.equal(
    (await h.call(`git -C '${other}' push origin main`))[0].block,
    true,
  );
  assert.deepEqual(await h.call(`git -C '${cwd}' push origin main`), []);
});

test("merge authorization follows an edited linked worktree to main and is single-use", async (t) => {
  const main = repo(t),
    feature = worktree(t, main),
    h = harness("/unrelated");
  h.edit(join(feature, "file.md"));
  await h.request();
  assert.deepEqual(await h.call(`git -C '${main}' push origin main`), []);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.records.at(-1).outcome, "explicit-request");
  assert.equal(
    (await h.call(`git -C '${main}' push origin main`))[0].block,
    true,
  );
  assert.equal(h.prompts.length, 1);
});

test("an explicit branch request can publish through a linked worktree", async (t) => {
  const main = repo(t),
    feature = worktree(t, main),
    h = harness(main);
  await h.request("please push to feature");
  assert.deepEqual(await h.call(`git -C '${feature}' push origin feature`), []);
  assert.equal(h.prompts.length, 0);
});

test("edits in multiple linked worktrees share a repository when the target branch is clear", async (t) => {
  const main = repo(t),
    feature = worktree(t, main);
  for (const request of [
    "please merge if necessary and push",
    "please push to feature",
  ]) {
    const h = harness("/unrelated");
    h.edit(join(main, "file.md"), "main-edit");
    h.edit(join(feature, "file.md"), "feature-edit");
    await h.request(request);
    const target = request.includes("merge") ? main : feature;
    const branch = request.includes("merge") ? "main" : "feature";
    assert.deepEqual(
      await h.call(`git -C '${target}' push origin ${branch}`),
      [],
    );
    assert.equal(h.prompts.length, 0);
  }
});

test("edits on different worktree branches need a clear publication target", async (t) => {
  const main = repo(t),
    feature = worktree(t, main),
    h = harness(main);
  h.edit(join(main, "file.md"), "main-edit");
  h.edit(join(feature, "file.md"), "feature-edit");
  await h.request("please push");
  assert.equal((await h.call("git push origin main"))[0].block, true);
});

test("a separate clone with the same origin cannot consume the authorization", async (t) => {
  const main = repo(t),
    clone = join(temporary(t), "clone"),
    h = harness(main);
  git(main, "clone", "--no-hardlinks", main, clone);
  git(
    clone,
    "remote",
    "set-url",
    "origin",
    git(main, "remote", "get-url", "origin"),
  );
  await h.request();
  assert.equal(
    (await h.call(`git -C '${clone}' push origin main`))[0].block,
    true,
  );
  assert.deepEqual(await h.call("git push origin main"), []);
});

for (const [key, value] of [
  ["remote.origin.pushurl", "https://example.invalid/other.git"],
  ["push.followTags", "true"],
  ["remote.origin.mirror", "true"],
])
  test(`linked worktree ${key} overrides retain confirmation`, async (t) => {
    const main = repo(t),
      feature = worktree(t, main),
      h = harness(main);
    git(main, "config", "extensions.worktreeConfig", "true");
    await h.request("please push to feature");
    git(feature, "config", "--worktree", key, value);
    assert.equal(
      (await h.call(`git -C '${feature}' push origin feature`))[0].block,
      true,
    );
  });

test("edited worktrees with different push destinations cannot establish one scope", async (t) => {
  const main = repo(t),
    feature = worktree(t, main),
    h = harness(main);
  git(main, "config", "extensions.worktreeConfig", "true");
  git(
    feature,
    "config",
    "--worktree",
    "remote.origin.pushurl",
    "https://example.invalid/other.git",
  );
  h.edit(join(main, "file.md"), "main-edit");
  h.edit(join(feature, "file.md"), "feature-edit");
  await h.request();
  assert.equal((await h.call("git push origin main"))[0].block, true);
});

test("detached linked worktrees cannot consume a publication authorization", async (t) => {
  const main = repo(t),
    feature = worktree(t, main),
    h = harness(main);
  await h.request("please push to feature");
  git(feature, "checkout", "--detach");
  assert.equal(
    (await h.call(`git -C '${feature}' push origin feature`))[0].block,
    true,
  );
});

test("failed edits cannot grant another repository's publication", async (t) => {
  const cwd = repo(t),
    other = repo(t),
    h = harness(cwd);
  h.edit(join(other, "file.md"), "failed", true);
  await h.request();
  assert.equal(
    (await h.call(`git -C '${other}' push origin main`))[0].block,
    true,
  );
});

test("a multi-repository request grants one push per edited repository only", async (t) => {
  const first = repo(t),
    second = repo(t),
    unrelated = repo(t),
    h = harness(unrelated);
  h.edit(join(first, "file.md"), "first");
  h.edit(join(second, "file.md"), "second");
  await h.request();
  assert.equal((await h.call("git push origin main"))[0].block, true);
  for (const cwd of [first, second]) {
    assert.deepEqual(await h.call(`git -C '${cwd}' push origin main`), []);
    assert.equal(h.records.at(-1).outcome, "explicit-request");
    assert.equal(
      (await h.call(`git -C '${cwd}' push origin main`))[0].block,
      true,
    );
  }
  assert.equal(h.prompts.length, 3);
});

test("each repository pins its own remote and target branch", async (t) => {
  const first = repo(t),
    second = repo(t),
    h = harness(first);
  git(second, "branch", "trunk");
  git(
    second,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/trunk",
  );
  h.edit(join(first, "file.md"), "first");
  h.edit(join(second, "file.md"), "second");
  await h.request();
  git(
    first,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/changed.git",
  );
  assert.equal((await h.call("git push origin main"))[0].block, true);
  git(second, "switch", "trunk");
  assert.deepEqual(await h.call(`git -C '${second}' push origin trunk`), []);
});

test("requested stale deletion is verified, leased and audited without a dialog", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    tip = staleBranch(cwd),
    h = harness(cwd);
  await h.request();
  assert.deepEqual(await h.call("git push origin main"), []);
  assert.deepEqual(await h.call("git push origin --delete stale"), []);
  const command = h.calls.at(-1).input.command;
  assert.ok(command.includes(`--force-with-lease=refs/heads/stale:${tip}`));
  assert.equal(h.prompts.length, 0);
  assert.equal(h.records.at(-1).reason, "Delete verified stale branch");
  assert.equal(h.records.at(-1).outcome, "explicit-request");
  execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
  assert.equal(
    git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/stale"),
    "",
  );
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
});

test("cleanup alone grants no publication and can remove multiple stale branches", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd, "first");
  staleBranch(cwd, "second");
  await h.request("please delete stale branches");
  assert.equal((await h.call("git push origin main"))[0].block, true);
  for (const branch of ["first", "second"])
    assert.deepEqual(await h.call(`git push --delete origin ${branch}`), []);
  assert.equal(h.prompts.length, 1);
});

test("squashed branches qualify only when every changed path matches published main", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  git(cwd, "switch", "-c", "squashed");
  writeFileSync(join(cwd, "file.md"), "integrated change\n");
  git(cwd, "commit", "-am", "Feature change");
  git(cwd, "push", "origin", "squashed");
  git(cwd, "switch", "main");
  git(cwd, "cherry-pick", "--no-commit", "squashed");
  git(cwd, "commit", "-m", "Squashed feature");
  git(cwd, "push", "origin", "main");
  assert.notEqual(
    git(cwd, "merge-base", "main", "squashed"),
    git(cwd, "rev-parse", "squashed"),
  );
  await h.request();
  assert.deepEqual(await h.call("git push origin --delete squashed"), []);
});

test("unmerged content and file-mode changes retain confirmation", async (t) => {
  for (const modeOnly of [false, true]) {
    const { cwd } = remoteRepo(t),
      h = harness(cwd);
    git(cwd, "switch", "-c", "active");
    if (modeOnly) chmodSync(join(cwd, "file.md"), 0o755);
    else writeFileSync(join(cwd, "file.md"), "unmerged\n");
    git(cwd, "add", "file.md");
    git(cwd, "commit", "-m", "Unmerged change");
    git(cwd, "push", "origin", "active");
    git(cwd, "switch", "main");
    await h.request();
    assert.equal(
      (await h.call("git push origin --delete active"))[0].block,
      true,
    );
  }
});

test("the default branch, checked-out branches and unsnapshotted refs retain confirmation", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd, "checked-out");
  const checkout = join(temporary(t), "checkout");
  git(cwd, "worktree", "add", checkout, "checked-out");
  await h.request();
  staleBranch(cwd, "new-after-request");
  for (const branch of ["main", "checked-out", "new-after-request"])
    assert.equal(
      (await h.call(`git push origin --delete ${branch}`))[0].block,
      true,
      branch,
    );
});

test("an advanced remote ref and changes to origin invalidate deletion", async (t) => {
  for (const changeOrigin of [false, true]) {
    const { cwd } = remoteRepo(t),
      h = harness(cwd);
    staleBranch(cwd);
    await h.request();
    if (changeOrigin)
      git(
        cwd,
        "remote",
        "set-url",
        "origin",
        "https://example.invalid/other.git",
      );
    else {
      git(cwd, "switch", "stale");
      writeFileSync(join(cwd, "file.md"), "new work\n");
      git(cwd, "commit", "-am", "New work");
      git(cwd, "push", "origin", "stale");
      git(cwd, "switch", "main");
    }
    assert.equal(
      (await h.call("git push origin --delete stale"))[0].block,
      true,
    );
  }
});

test("the deletion lease protects a branch that advances after the guard check", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd);
  await h.request();
  assert.deepEqual(await h.call("git push origin --delete stale"), []);
  const command = h.calls.at(-1).input.command;
  git(cwd, "switch", "stale");
  writeFileSync(join(cwd, "file.md"), "racing work\n");
  git(cwd, "commit", "-am", "Concurrent work");
  git(cwd, "push", "origin", "stale");
  const tip = git(cwd, "rev-parse", "stale");
  git(cwd, "switch", "main");
  assert.throws(() =>
    execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" }),
  );
  assert.equal(git(remote, "rev-parse", "refs/heads/stale"), tip);
});

test("concurrent deletion calls cannot spend the same ref grant twice", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd);
  await h.request();
  const results = await Promise.all([
    h.call("git push origin --delete stale"),
    h.call("git push origin --delete stale"),
  ]);
  assert.equal(results.filter((result) => result.length === 0).length, 1);
  assert.equal(h.prompts.length, 1);
});

test("deletion grants do not survive new input and cannot enter nested or headless calls", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd);
  await h.request();
  assert.equal(
    (
      await h.call("git push origin --delete stale", {
        parentToolCallId: "outer",
      })
    )[0].block,
    true,
  );
  await h.request("actually wait");
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
  await h.request();
  h.ctx.hasUI = false;
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
});

test("opaque cleanup commands and deletions without an explicit cleanup request retain confirmation", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  staleBranch(cwd);
  await h.request("please push");
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
  await h.request();
  for (const command of [
    "git push origin --delete stale && git status",
    "bash -c 'git push origin --delete stale'",
    "git push --force origin main",
    "git push origin --delete stale main",
    "git push origin :stale",
  ])
    assert.equal((await h.call(command))[0].block, true, command);
});

for (const event of [
  "agent_settled",
  "session_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_shutdown",
])
  test(`publication does not survive ${event}`, async (t) => {
    const cwd = repo(t),
      h = harness(cwd);
    await h.request();
    await h.emit(event);
    assert.equal((await h.call("git push origin main"))[0].block, true);
  });
for (const input of [
  { source: "extension" },
  { source: "interactive", streamingBehavior: "steer" },
  { source: "interactive", streamingBehavior: "followUp" },
])
  test(`injected or streaming input cannot grant publication: ${JSON.stringify(input)}`, async (t) => {
    const cwd = repo(t),
      h = harness(cwd);
    await h.request(undefined, input);
    assert.equal((await h.call("git push origin main"))[0].block, true);
  });

test("only a live authorized user run receives standalone-push guidance", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  const ordinary = { promptGuidelines: [] };
  await h.emit("before_agent_start", {
    messageType: "user",
    systemPromptOptions: ordinary,
  });
  assert.deepEqual(ordinary.promptGuidelines, []);
  await h.request();
  const authorized = { promptGuidelines: [] };
  await h.emit("before_agent_start", {
    messageType: "user",
    systemPromptOptions: authorized,
  });
  assert.match(authorized.promptGuidelines.join("\n"), /standalone git -C/);
  assert.deepEqual(await h.call("git push origin main"), []);
});

test("a new message revokes the earlier grant", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  await h.request("actually wait");
  assert.equal((await h.call("git push origin main"))[0].block, true);
});
test("a custom continuation cannot inherit authorization", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  await h.emit("before_agent_start", { messageType: "custom" });
  assert.equal((await h.call("git push origin main"))[0].block, true);
});
test("headless and nested tool calls do not inherit authorization", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  assert.equal(
    (await h.call("git push origin main", { parentToolCallId: "outer" }))[0]
      .block,
    true,
  );
  h.ctx.hasUI = false;
  assert.equal((await h.call("git push origin main"))[0].block, true);
  assert.equal(h.prompts.length, 1);
});

for (const command of [
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git push --delete origin main",
  "git push origin main --follow-tags",
  "git push origin",
  "git push",
  "git push origin other",
  "git push other main",
  "git push origin main other",
  "git -c core.sshCommand=evil push origin main",
  "bash -c 'git push origin main'",
  "ssh fixture-host 'git push origin main'",
  "node -e \"require('child_process').execSync('git push origin main')\"",
  "echo $(git push origin main)",
  "git push origin main && rm -rf /important",
  "git push origin main; git push origin main",
  "git config remote.origin.url evil && git push origin main",
])
  test(`explicit push request does not bypass a broader operation: ${command}`, async (t) => {
    const cwd = repo(t),
      h = harness(cwd);
    await h.request();
    assert.equal((await h.call(command))[0].block, true);
    assert.equal(h.prompts.length, 1);
  });

test("origin URL changes and implicit extra published refs invalidate authorization", async (t) => {
  for (const setting of [
    ["remote.origin.url", "https://example.invalid/other.git"],
    ["push.followTags", "true"],
    ["push.followTags", "2"],
    ["push.followTags", "-1"],
    ["remote.origin.mirror", "true"],
    ["remote.origin.pushurl", "https://example.invalid/other.git"],
  ]) {
    const cwd = repo(t),
      h = harness(cwd);
    await h.request();
    git(cwd, "config", ...setting);
    assert.equal((await h.call("git push origin main"))[0].block, true);
  }
});
test("valueless Git booleans cannot implicitly authorize extra refs", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  fs.appendFileSync(join(cwd, ".git/config"), "\n[push]\n\tfollowTags\n");
  assert.equal((await h.call("git push origin main"))[0].block, true);
});
test("standalone publication rejects executable wrappers and config-writing companions", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  for (const command of [
    "/tmp/wrapper/git push origin main",
    "git log -1 --format='[remote \"origin\"]%nurl = https://example.invalid/other.git' --output=.git/config && git push origin main",
    "git push origin main > /important",
  ]) {
    assert.equal((await h.call(command))[0].block, true, command);
  }
});
test("Git -C symlink/.. uses filesystem traversal rather than lexical path collapse", async (t) => {
  const cwd = repo(t),
    other = repo(t);
  mkdirSync(join(other, "subdir"));
  symlinkSync(join(other, "subdir"), join(cwd, "link"));
  assert.equal(
    git(cwd, "-C", "link/..", "rev-parse", "--show-toplevel"),
    other,
  );
  const h = harness(cwd);
  await h.request();
  assert.equal(
    (await h.call("git -C link/.. push origin main"))[0].block,
    true,
  );
  assert.deepEqual(await h.call("git push origin main"), []);
});
test("successful symlink edits scope to the real edited file's repository", async (t) => {
  const cwd = repo(t),
    other = repo(t);
  symlinkSync(join(other, "file.md"), join(cwd, "linked.md"));
  const h = harness(cwd);
  h.edit(join(cwd, "linked.md"));
  await h.request();
  assert.equal((await h.call("git push origin main"))[0].block, true);
  assert.deepEqual(await h.call(`git -C '${other}' push origin main`), []);
});
test("dotted target branches are not split into maintenance instructions", async (t) => {
  const cwd = repo(t);
  git(cwd, "switch", "-c", "Release");
  const h = harness(cwd);
  await h.request("please push to Release.commit");
  assert.equal((await h.call("git push origin Release"))[0].block, true);
  git(cwd, "switch", "-c", "Release.commit");
  assert.deepEqual(await h.call("git push origin Release.commit"), []);
});
test("merge requests without a known default branch do not guess", async (t) => {
  const cwd = repo(t);
  git(cwd, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const h = harness(cwd);
  await h.request();
  assert.equal((await h.call("git push origin main"))[0].block, true);
});
test("merge requests bind to origin's default branch, while ordinary pushes stay on the current branch", async (t) => {
  const cwd = repo(t);
  git(cwd, "switch", "-c", "feature");
  const h = harness(cwd);
  await h.request("please merge if necessary and push");
  assert.equal((await h.call("git push origin feature"))[0].block, true);
  git(cwd, "switch", "main");
  assert.deepEqual(await h.call("git push origin HEAD:main"), []);
});
test("explicit target branch is case-sensitive", async (t) => {
  const cwd = repo(t);
  git(cwd, "switch", "-c", "Release");
  const h = harness(cwd);
  await h.request("please push to Release");
  assert.deepEqual(await h.call("git push origin Release"), []);
});
test("concurrent tool calls cannot spend a grant twice", async (t) => {
  const cwd = repo(t),
    h = harness(cwd);
  await h.request();
  const results = await Promise.all([
    h.call("git push origin main"),
    h.call("git push origin main"),
  ]);
  assert.equal(results.filter((result) => result.length === 0).length, 1);
  assert.equal(h.prompts.length, 1);
});

test("owned temporary cleanup is logged without a confirmation", async (t) => {
  const h = harness(temporary(t)),
    command = `bundle=$(mktemp /tmp/approval-test.XXXXXX.bundle)\ntrap 'rm -f -- "$bundle"' EXIT\ncat "$bundle"`;
  assert.equal(commandRisk(command), undefined);
  assert.deepEqual(await h.call(command), []);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.records.at(-1).outcome, "owned-temp-cleanup");
  assert.equal((await h.call(command + "\nrm -rf /important"))[0].block, true);
});

test("audit records actual prompts separately from decisions and never store tool arguments", async (t) => {
  const h = harness(temporary(t));
  const secret = "TOKEN-DO-NOT-LOG";
  await h.call(`curl -X POST https://example.invalid/${secret}`);
  assert.deepEqual(
    h.records.map((r) => [r.phase, r.outcome]),
    [
      ["prompt", undefined],
      ["decision", "denied"],
    ],
  );
  h.ctx.ui.confirm = async () => true;
  await h.call("git push origin main");
  assert.equal(h.records.at(-1).outcome, "allowed");
  h.ctx.hasUI = false;
  await h.call("git push origin main");
  assert.equal(h.records.at(-1).outcome, "blocked");
  assert.equal(h.records.filter((r) => r.phase === "prompt").length, 2);
  assert.doesNotMatch(JSON.stringify(h.records), new RegExp(secret));
  assert.ok(
    h.records.every(
      (r) => !("command" in r) && !("input" in r) && !("path" in r),
    ),
  );
});
test("UI errors and audit failures fail closed", async (t) => {
  const h = harness(temporary(t));
  h.ctx.ui.confirm = async () => {
    throw Error("UI unavailable");
  };
  await assert.rejects(h.call("git push origin main"), /UI unavailable/);
  assert.equal(h.records.at(-1).outcome, "error");
  h.pi.appendEntry = () => {
    throw Error("disk full");
  };
  await assert.rejects(
    h.call("git push origin main"),
    /Approval audit unavailable/,
  );
});

test("private audit files use 0700 directories and 0600 files", (t) => {
  const directory = join(temporary(t), "approval-log"),
    record = {
      version: 1,
      timestamp: new Date().toISOString(),
      toolCallId: "id",
      tool: "bash",
      phase: "prompt",
      reason: "Publish repository changes",
    };
  appendAudit(directory, "session-id", record);
  const file = join(directory, "session-id.jsonl");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), record);
  chmodSync(file, 0o644);
  appendAudit(directory, "session-id", {
    ...record,
    phase: "decision",
    outcome: "denied",
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});
test("audit refuses symlinks, hardlinks and path traversal", (t) => {
  const root = temporary(t),
    directory = join(root, "logs"),
    target = join(root, "target");
  mkdirSync(directory);
  writeFileSync(target, "untouched");
  const record = {
    version: 1,
    timestamp: "now",
    toolCallId: "id",
    tool: "bash",
    phase: "prompt",
    reason: "publish",
  };
  symlinkSync(target, join(directory, "linked.jsonl"));
  assert.throws(() => appendAudit(directory, "linked", record));
  assert.equal(readFileSync(target, "utf8"), "untouched");
  linkSync(target, join(directory, "hardlinked.jsonl"));
  assert.throws(() => appendAudit(directory, "hardlinked", record));
  symlinkSync(directory, join(root, "alias"));
  assert.throws(() => appendAudit(join(root, "alias"), "id", record));
  assert.throws(() => appendAudit(directory, "../escape", record));
  assert.equal(existsSync(join(root, "escape.jsonl")), false);
});

test("temporary cleanup cannot hide replacement of the allocated file with permanent data", () => {
  const shell = `bundle=$(mktemp /tmp/approval-test.XXXXXX.bundle)\ntrap 'rm -f -- "$bundle"' EXIT\nmv /important "$bundle"`;
  for (const command of [
    shell,
    `node <<'JS'\nconst {execFileSync}=require('node:child_process');\nconst script=\`${shell}\`;\nexecFileSync('bash',['-c',script]);\nJS`,
  ])
    assert.ok(commandRisk(command), command);
});
test("incomplete audit writes are never reported as successfully logged", async (t) => {
  const directory = join(temporary(t), "logs");
  const original = fs.writeSync;
  fs.writeSync = (fd, line) => original(fd, Buffer.from(line).subarray(0, 1));
  syncBuiltinESMExports();
  try {
    // Jiti snapshots native imports. Reload the module after replacing the writer.
    const isolated = createJiti(import.meta.url, {
      tryNative: false,
      moduleCache: false,
      fsCache: false,
      alias: {
        "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
      },
    });
    const { appendAudit: shortWriteAudit } = await isolated.import(
      new URL("../extensions/approval/audit.ts", import.meta.url).pathname,
    );
    assert.throws(
      () =>
        shortWriteAudit(directory, "session", {
          version: 1,
          timestamp: "now",
          toolCallId: "id",
          tool: "bash",
          phase: "prompt",
          reason: "publish",
        }),
      /Incomplete approval audit write/,
    );
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
  }
  const file = join(directory, "session.jsonl");
  assert.equal(readFileSync(file, "utf8"), "{");
  assert.throws(
    () =>
      appendAudit(directory, "session", {
        version: 1,
        timestamp: "later",
        toolCallId: "retry",
        tool: "bash",
        phase: "prompt",
        reason: "publish",
      }),
    /Incomplete approval audit tail/,
  );
  assert.equal(
    readFileSync(file, "utf8"),
    "{",
    "retry does not append another record to the incomplete line",
  );
});

test("undecoded trap quoting cannot hide deferred publication or deletion", () => {
  for (const command of [
    "trap $'git push origin main' EXIT",
    "trap -- $'rm -rf /important' EXIT",
    "trap $cleanup EXIT",
  ])
    assert.ok(commandRisk(command), command);
});

test("ordinary pushes pin the destination ref and commit despite mapping and later config changes", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  const original = git(cwd, "rev-parse", "HEAD");
  git(cwd, "branch", "production");
  git(cwd, "push", "origin", "production");
  git(
    cwd,
    "config",
    "remote.origin.push",
    "+refs/heads/main:refs/heads/production",
  );
  git(cwd, "config", "push.recurseSubmodules", "on-demand");
  writeFileSync(join(cwd, "file.md"), "approved\n");
  git(cwd, "commit", "-am", "Approved change");
  const approved = git(cwd, "rev-parse", "HEAD");
  await h.request("please push");
  assert.deepEqual(await h.call("git push origin main"), []);
  const command = h.calls.at(-1).input.command;
  assert.ok(command.includes(`${approved}:refs/heads/main`));
  assert.ok(command.includes("--recurse-submodules=no"));
  writeFileSync(join(cwd, "file.md"), "later unrelated change\n");
  git(cwd, "commit", "-am", "Later change");
  git(cwd, "config", "remote.origin.mirror", "true");
  git(cwd, "config", "push.followTags", "true");
  execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
  assert.equal(git(remote, "rev-parse", "main"), approved);
  assert.equal(git(remote, "rev-parse", "production"), original);
});

test("the executed command clears inherited Git overrides without copying their values", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    other = repo(t),
    h = harness(cwd);
  writeFileSync(join(cwd, "file.md"), "approved\n");
  git(cwd, "commit", "-am", "Approved change");
  const tip = git(cwd, "rev-parse", "HEAD"),
    previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, ".git");
  try {
    await h.request("please push");
    assert.deepEqual(await h.call("git push origin main"), []);
    const command = h.calls.at(-1).input.command;
    assert.ok(command.includes("GIT_DIR"));
    assert.equal(command.includes(process.env.GIT_DIR), false);
    execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  assert.equal(git(remote, "rev-parse", "main"), tip);
});

test("submodule ignore settings cannot hide an unmerged gitlink", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  const first = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-index", "--add", "--cacheinfo", `160000,${first},child`);
  git(cwd, "commit", "-m", "Add gitlink");
  git(cwd, "push", "origin", "main");
  const second = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-c", "unmerged-gitlink");
  git(cwd, "update-index", "--cacheinfo", `160000,${second},child`);
  git(cwd, "commit", "-m", "Change gitlink");
  git(cwd, "push", "origin", "unmerged-gitlink");
  git(cwd, "switch", "main");
  git(cwd, "config", "diff.ignoreSubmodules", "all");
  git(cwd, "config", "submodule.child.ignore", "all");
  await h.request();
  assert.equal(
    (await h.call("git push origin --delete unmerged-gitlink"))[0].block,
    true,
  );
});

test("replacement objects cannot make an unmerged branch qualify for deletion", async (t) => {
  const { cwd } = remoteRepo(t),
    h = harness(cwd);
  const main = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-c", "unmerged");
  writeFileSync(join(cwd, "file.md"), "unmerged\n");
  git(cwd, "commit", "-am", "Unmerged change");
  const tip = git(cwd, "rev-parse", "HEAD");
  git(cwd, "push", "origin", "unmerged");
  git(cwd, "switch", "main");
  git(cwd, "replace", tip, main);
  await h.request();
  assert.equal(
    (await h.call("git push origin --delete unmerged"))[0].block,
    true,
  );
});

test("retargeting origin after validation cannot redirect a leased deletion", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  const tip = staleBranch(cwd),
    other = join(temporary(t), "other.git");
  git(cwd, "clone", "--bare", remote, other);
  await h.request();
  assert.deepEqual(await h.call("git push origin --delete stale"), []);
  const command = h.calls.at(-1).input.command;
  git(cwd, "remote", "set-url", "origin", other);
  execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
  assert.equal(
    git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/stale"),
    "",
  );
  assert.equal(git(other, "rev-parse", "stale"), tip);
});

test("relative remotes and credential-bearing HTTP URLs retain confirmation", async (t) => {
  for (const url of [
    "../origin.git",
    "https://TOKEN@example.invalid/repo.git",
    "https://user:SECRET@example.invalid/repo.git",
  ]) {
    const cwd = repo(t),
      h = harness(cwd);
    git(cwd, "remote", "set-url", "origin", url);
    await h.request();
    assert.equal((await h.call("git push origin main"))[0].block, true);
    assert.equal(JSON.stringify(h.records).includes(url), false);
  }
});

test("live remote verification rejects advancement absent from the tracking cache", async (t) => {
  const { cwd, remote } = remoteRepo(t),
    h = harness(cwd);
  const original = staleBranch(cwd);
  await h.request();
  git(cwd, "switch", "-c", "incoming");
  writeFileSync(join(cwd, "file.md"), "new work\n");
  git(cwd, "commit", "-am", "Incoming change");
  git(cwd, "push", "origin", "incoming");
  git(remote, "update-ref", "refs/heads/stale", git(cwd, "rev-parse", "HEAD"));
  git(cwd, "switch", "main");
  assert.equal(git(cwd, "rev-parse", "origin/stale"), original);
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
});

test("multi-repository cleanup grants stay independent and exclude unrelated clones", async (t) => {
  const first = remoteRepo(t).cwd,
    second = remoteRepo(t).cwd,
    unrelated = remoteRepo(t).cwd;
  for (const cwd of [first, second, unrelated]) staleBranch(cwd);
  const h = harness(unrelated);
  h.edit(join(first, "file.md"), "first");
  h.edit(join(second, "file.md"), "second");
  await h.request();
  assert.equal((await h.call("git push origin --delete stale"))[0].block, true);
  for (const cwd of [first, second])
    assert.deepEqual(
      await h.call(`git -C '${cwd}' push origin --delete stale`),
      [],
    );
  assert.equal(h.prompts.length, 1);
});

test("push parsing never treats substitutions or remote wrappers as direct local publication", () => {
  for (const command of [
    "(git push origin main)",
    "git push origin $(echo main)",
    "git push -u --force origin main",
    "git push --set-upstream origin main other",
    "git push -u --set-upstream origin main",
    "git push -u other main",
    "git push -u origin main && git status",
    "echo `git push origin main`",
    "env git push origin main",
    "ssh fixture-host git push origin main",
    "cd /repo; git push origin main",
  ])
    assert.equal(pushInvocation(command, "/repo"), undefined, command);
});

function configuration(t, value) {
  const path = join(temporary(t), "config.json");
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  const previous = process.env.PI_EXTENSIONS_CONFIG;
  process.env.PI_EXTENSIONS_CONFIG = path;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_EXTENSIONS_CONFIG;
    else process.env.PI_EXTENSIONS_CONFIG = previous;
  });
}

for (const command of [
  "service-cli records create",
  "service-cli records update 123",
  "service-cli records frobnicate",
  "service-cli --profile list frobnicate",
  "service-cli",
  "/fixture/bin/service-cli records frobnicate",
  "env service-cli records frobnicate",
  "command service-cli records frobnicate",
  "sh -c 'service-cli records frobnicate'",
  "ssh fixture-host 'service-cli records frobnicate'",
  "echo $(service-cli records frobnicate)",
  "printf '%s' 'service-cli records frobnicate' | sh",
  "find . -exec service-cli records frobnicate \\;",
  "xargs -n 1 service-cli records frobnicate",
  "node -e \"require('child_process').execSync('service-cli records frobnicate')\"",
])
  test(`configured executables fail closed, including nested commands: ${command}`, () => {
    assert.ok(commandRisk(command, { protectedCommands: ["service-cli"] }));
  });

for (const command of [
  "service-cli records get 123",
  "service-cli records list",
  "service-cli status",
  "service-cli --help",
  "service-cli --version",
])
  test(`configured read-only commands stay available: ${command}`, () => {
    assert.equal(
      commandRisk(command, { protectedCommands: ["service-cli"] }),
      undefined,
    );
  });

test("configuration adds protections without replacing generic defaults", async (t) => {
  configuration(t, { approval: { protectedCommands: ["service-cli"] } });
  const h = harness(temporary(t));
  h.ctx.hasUI = false;
  for (const command of [
    "service-cli records frobnicate",
    "git push origin main",
    "rm -rf /important",
    "sudo true",
    "curl -X DELETE https://example.invalid/data",
  ])
    assert.equal((await h.call(command))[0].block, true, command);
  assert.deepEqual(await h.call("service-cli records get 123"), []);
  assert.deepEqual(await h.call("unconfigured-cli unknown"), []);
  assert.equal(h.prompts.length, 0);
});

test("invalid configuration retains a blocking guard instead of dropping protection", async (t) => {
  configuration(t, { approval: { protectedCommands: ["invalid command"] } });
  const h = harness(temporary(t));
  assert.equal(approvalStatus(h.pi).ready, false);
  assert.equal((await h.call("printf safe"))[0].block, true);
  assert.equal(h.prompts.length, 0);
});

test("worker instructions cannot grant publication on behalf of the user", async (t) => {
  const previous = process.env.PI_SUPERVISOR_WORKER;
  process.env.PI_SUPERVISOR_WORKER = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUPERVISOR_WORKER;
    else process.env.PI_SUPERVISOR_WORKER = previous;
  });
  const h = harness(repo(t));
  await h.request("please push", { source: "rpc" });
  assert.equal((await h.call("git push origin main"))[0].block, true);
  assert.equal(h.prompts.length, 1);
});

async function integrated(t, names, options = {}) {
  const cwd = temporary(t);
  const events = createEventBus();
  const base = options.base || new URL("..", import.meta.url).pathname;
  const loaded = await loadExtensions(
    names.map((name) => join(base, "extensions", name, "index.ts")),
    cwd,
    events,
  );
  assert.deepEqual(loaded.errors, []);
  const manager = SessionManager.inMemory(cwd);
  if (options.saved !== undefined)
    manager.appendCustomEntry("dotfiles-workflows", {
      planning: options.saved,
      tasks: [],
    });
  const prompts = [],
    notices = [];
  let tools = ["read", "write", "bash"];
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.getActiveTools = () => tools;
  loaded.runtime.setActiveTools = (value) => {
    tools = value;
  };
  loaded.runtime.appendEntry = (name, data) =>
    manager.appendCustomEntry(name, data);
  loaded.runtime.flagValues.set("plan", options.flag === true);
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    sessionManager: manager,
    ui: {
      confirm: async (...args) => {
        prompts.push(args);
        return true;
      },
      notify: (...args) => notices.push(args),
      setStatus() {},
      setWidget() {},
    },
  };
  const emit = async (type, event = {}) => {
    for (const extension of loaded.extensions)
      for (const handler of extension.handlers.get(type) || []) {
        const result = await handler({ type, ...event }, ctx);
        if (type === "tool_call" && result?.block) return result;
      }
  };
  let next = 0;
  const call = (toolName, input = {}) =>
    emit("tool_call", { toolName, input, toolCallId: `integration-${++next}` });
  const command = (name, args) =>
    loaded.extensions
      .flatMap((ext) => [...ext.commands.values()])
      .find((item) => item.name === name)
      .handler(args, ctx);
  t.after(() => emit("session_shutdown"));
  await emit("session_start", { reason: "startup" });
  return {
    loaded,
    events,
    ctx,
    manager,
    prompts,
    notices,
    emit,
    call,
    command,
    status: () => approvalStatus({ events }),
  };
}

for (const names of [
  ["workflows"],
  ["supervisor"],
  ["approval", "workflows"],
  ["workflows", "approval"],
  ["approval", "supervisor"],
  ["supervisor", "approval"],
  ["approval", "workflows", "supervisor"],
  ["supervisor", "workflows", "approval"],
])
  test(`filtered installation registers one approval guard with no duplicate prompts: ${names.join(", ")}`, async (t) => {
    const h = await integrated(t, names);
    assert.equal(h.status().ready, true);
    const markers = h.loaded.extensions
      .flatMap((ext) => [...ext.commands.keys()])
      .filter((name) => name === "pi-extensions-approval-ready-v1");
    assert.equal(markers.length, 1);
    assert.equal(
      await h.call("bash", { command: "git push origin main" }),
      undefined,
    );
    assert.equal(h.prompts.length, 1);
    assert.equal(
      await h.call("bash", { command: "git push origin main" }),
      undefined,
    );
    assert.equal(
      h.prompts.length,
      2,
      "Each operation requires one fresh approval",
    );
  });

for (const options of [
  { flag: true },
  { saved: true },
  { flag: true, saved: false },
])
  test(`standalone workflows enforces initial or restored plan mode: ${JSON.stringify(options)}`, async (t) => {
    const h = await integrated(t, ["workflows"], options);
    assert.equal(h.status().planning, true);
    for (const [name, input] of [
      ["bash", { command: "printf safe" }],
      ["write", { path: "source.ts" }],
      ["subagent", {}],
      ["unclassified", {}],
    ])
      assert.equal((await h.call(name, input)).block, true, name);
    assert.equal(await h.call("read", { path: "source.ts" }), undefined);
    assert.equal(h.prompts.length, 0);
    await h.command("plan", "off");
    await h.emit("session_start", { reason: "reload" });
    assert.equal(
      h.status().planning,
      false,
      "Explicit off survives reload even with --plan",
    );
    assert.equal(await h.call("bash", { command: "printf safe" }), undefined);
    await h.command("plan", "on");
    assert.equal(h.manager.getBranch().at(-1).customType, "dotfiles-workflows");
    assert.equal(
      (await h.call("bash", { command: "printf safe" })).block,
      true,
    );
  });

test("workflow plan restoration follows only the active branch and clears on navigation", async (t) => {
  const h = await integrated(t, ["workflows"]);
  const root = h.manager.appendCustomEntry("fixture-root", {});
  await h.command("plan", "on");
  h.manager.branch(root);
  h.manager.appendCustomEntry("dotfiles-workflows", {
    planning: false,
    tasks: [],
  });
  await h.emit("session_tree");
  assert.equal(h.status().planning, false);
});

test("damaged persisted plans cannot silently restore execution mode", async (t) => {
  const h = await integrated(t, ["workflows"]);
  for (const value of [
    null,
    { planning: true, tasks: [null] },
    { planning: true },
    { planning: "unknown", tasks: [] },
  ]) {
    h.manager.appendCustomEntry("dotfiles-workflows", value);
    await h.emit("session_tree");
    assert.equal(h.status().planning, true);
    assert.equal(
      (await h.call("bash", { command: "printf safe" })).block,
      true,
    );
  }
});

test("missing shipped subagent example retains standalone planning and approval", async (t) => {
  const previous = process.env.PI_PARITY_PACKAGE_DIR;
  process.env.PI_PARITY_PACKAGE_DIR = temporary(t);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_PARITY_PACKAGE_DIR;
    else process.env.PI_PARITY_PACKAGE_DIR = previous;
  });
  const h = await integrated(t, ["workflows"], { flag: true });
  assert.equal(h.status().planning, true);
  assert.equal((await h.call("bash", { command: "printf safe" })).block, true);
  assert.ok(
    h.notices.some((args) =>
      /subagent example could not be loaded/.test(args[0]),
    ),
  );
});

test("checklist updates do not revoke a publication grant, but plan transitions do", async (t) => {
  const h = harness(repo(t));
  await h.request();
  h.pi.events.emit("dotfiles:plan-mode", false);
  assert.deepEqual(await h.call("git push origin main"), []);
  await h.request();
  h.pi.events.emit("dotfiles:plan-mode", true);
  h.pi.events.emit("dotfiles:plan-mode", false);
  assert.equal((await h.call("git push origin main"))[0].block, true);
});

for (const name of ["workflows", "supervisor"])
  test(`missing bundled approval leaves standalone ${name} fail closed`, async (t) => {
    const base = temporary(t);
    cpSync(
      new URL(`../extensions/${name}`, import.meta.url),
      join(base, "extensions", name),
      { recursive: true },
    );
    mkdirSync(join(base, "extensions/approval"), { recursive: true });
    cpSync(
      new URL("../extensions/approval/ready.ts", import.meta.url),
      join(base, "extensions/approval/ready.ts"),
    );
    const h = await integrated(t, [name], { base, saved: true, flag: true });
    assert.equal(h.status(), undefined);
    assert.equal(
      (await h.call("bash", { command: "printf safe" })).block,
      true,
    );
    assert.equal((await h.call("write", { path: "source.ts" })).block, true);
    assert.equal(h.prompts.length, 0);
    assert.ok(h.notices.some((args) => /guard unavailable/.test(args[0])));
  });

test("broken configuration keeps restored plans blocked in a filtered workflow install", async (t) => {
  configuration(t, "{ invalid json");
  const h = await integrated(t, ["workflows"], { saved: true });
  assert.equal(h.status().ready, false);
  assert.equal((await h.call("read", { path: "source.ts" })).block, true);
  assert.equal(h.prompts.length, 0);
});

test("consumer health checks block tools when a previously ready guard disappears", async (t) => {
  const h = await integrated(t, ["approval", "workflows"]);
  for (const handler of h.loaded.extensions[0].handlers.get("session_shutdown"))
    await handler({}, h.ctx);
  assert.equal(h.status(), undefined);
  assert.equal((await h.call("write", { path: "source.ts" })).block, true);
});

test("readiness queries clean up response listeners and do not start models", async () => {
  const events = createEventBus();
  let replies = 0;
  const off = events.on(APPROVAL_QUERY, (data) => {
    replies++;
    events.emit(APPROVAL_READY, {
      ...data,
      version: 1,
      ready: true,
      planning: false,
    });
  });
  for (let i = 0; i < 50; i++)
    assert.equal(approvalStatus({ events }).ready, true);
  assert.equal(replies, 50);
  off();
  assert.equal(approvalStatus({ events }), undefined);
});
