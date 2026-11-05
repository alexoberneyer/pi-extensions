import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shellCommands } from "./shell.ts";

const execute = promisify(execFile);

/** Deliberately recognize direct instructions, not prose mentioning publication. */
export function publishRequest(
  text: string,
):
  | { push: boolean; merge: boolean; cleanup: boolean; branch?: string }
  | undefined {
  const instruction = text
    .trim()
    .replace(/^(?:(?:great|nice|yes|thanks|thank you)[,.!\s]+)*/i, "");
  if (
    instruction.includes("?") &&
    !/^(?:can|could|would) you\b/i.test(instruction)
  )
    return;
  const clauses = instruction
    .replace(/^(?:can|could|would) you (?:please )?/i, "")
    .replace(/(?:[,.!\s]+(?:thanks|thank you))?[.!?\s]*$/i, "")
    .split(/\s*(?:,|\band\b|\bthen\b|\.(?=\s|$))\s*/i)
    .filter(Boolean)
    .map((clause) => clause.replace(/^please\s+/i, ""));
  let push = false,
    merge = false,
    cleanup = false,
    branch: string | undefined;
  for (const clause of clauses) {
    const publication =
      /^(?:git )?push(?: it| this| these changes| the changes)?(?: to ([a-z0-9][a-z0-9._/-]*))?$/i.exec(
        clause,
      );
    if (publication) {
      if (push) return;
      push = true;
      branch = publication[1];
    } else if (
      /^merge(?: it| this| the changes)?(?: if necessary)?$/i.test(clause)
    )
      merge = true;
    else if (/^delete stale branches$/i.test(clause)) cleanup = true;
    else if (
      !/^(?:commit(?: it| this| the changes)?|pull(?: it| the changes)?)$/i.test(
        clause,
      )
    )
      return;
  }
  if (push || cleanup)
    return { push, merge, cleanup, ...(branch ? { branch } : {}) };
}

async function git(
  cwd: string,
  args: string[],
  optional = false,
  trim = true,
): Promise<string> {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    const { stdout } = await execute(
      "git",
      ["--no-replace-objects", "-C", cwd, ...args],
      {
        env,
        timeout: args[0] === "ls-remote" ? 5_000 : 1_500,
        maxBuffer: 32_768,
        encoding: "utf8",
      },
    );
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    if (optional && (error as { code?: number }).code === 1) return "";
    throw error;
  }
}

interface Repository {
  root: string;
  commonDir: string;
  branch: string;
  remote: string;
}
async function repository(cwd: string): Promise<Repository> {
  const [root, commonDir, branch] = (
    await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--abbrev-ref",
      "HEAD",
    ])
  ).split("\n");
  const urls = (
    await git(cwd, ["remote", "get-url", "--push", "--all", "origin"])
  ).split("\n");
  const extras = await Promise.all(
    ["remote.origin.mirror", "push.followTags"].map((key) =>
      git(cwd, ["config", "--type=bool", "--get", key], true),
    ),
  );
  if (
    !root ||
    !commonDir ||
    !branch ||
    branch === "HEAD" ||
    urls.length !== 1 ||
    !urls[0] ||
    extras.includes("true") ||
    (!isAbsolute(urls[0]) &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(urls[0]) &&
      !/^[^/\s]+:/.test(urls[0])) ||
    (/^https?:\/\//i.test(urls[0]) &&
      Boolean(new URL(urls[0]).username || new URL(urls[0]).password))
  )
    throw Error("Ambiguous publication target");
  return {
    root: realpathSync(root),
    commonDir: realpathSync(commonDir),
    branch,
    remote: urls[0],
  };
}

/** Only successful edits from the preceding user task establish a different repo. */
function editedPaths(ctx: ExtensionContext): string[] {
  const messages = ctx.sessionManager
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  const calls = new Map<string, string>();
  const paths = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (message.role === "assistant")
      for (const part of message.content) {
        if (
          part.type === "toolCall" &&
          ["edit", "write"].includes(part.name) &&
          typeof part.arguments.path === "string"
        )
          calls.set(part.id, part.arguments.path);
      }
    if (message.role === "toolResult" && !message.isError) {
      const path = calls.get(message.toolCallId);
      if (path) paths.add(realpathSync.native(resolve(ctx.cwd, path)));
    }
  }
  return [...paths];
}

/** Only one literal local git invocation. Compound commands retain confirmation. */
function gitInvocation(
  source: string,
  cwd: string,
): { cwd: string; words: string[]; args: string[] } | undefined {
  if (/[$`;&|()<>\r\n]/.test(source)) return;
  const commands = shellCommands(source);
  if (
    commands.length !== 1 ||
    commands[0].nested ||
    commands[0].group ||
    commands[0].upstream
  )
    return;
  const words = commands[0].words;
  if (words[0] !== "git") return;
  let args = words.slice(1);
  if (args[0] === "-C" && args[1] && !/[~\r\n]/.test(args[1])) {
    // Do not collapse link/.. before Git traverses the filesystem.
    cwd = isAbsolute(args[1]) ? args[1] : `${cwd}/${args[1]}`;
    args = args.slice(2);
  }
  return { cwd, words, args };
}

export function pushInvocation(
  source: string,
  cwd: string,
):
  | { cwd: string; words: string[]; branch: string; setUpstream: boolean }
  | undefined {
  const call = gitInvocation(source, cwd);
  if (!call) return;
  const { words } = call;
  const args = [...call.args];
  if (args[0] !== "push") return;
  const upstream = args.findIndex((arg) =>
    ["-u", "--set-upstream"].includes(arg),
  );
  if (upstream !== -1) args.splice(upstream, 1);
  if (args.length !== 3 || args[1] !== "origin") return;
  const branch = args[2].replace(/^HEAD:/, "");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    (args[2].includes(":") && args[2] !== `HEAD:${branch}`)
  )
    return;
  return { cwd: call.cwd, words, branch, setUpstream: upstream !== -1 };
}

function deleteInvocation(source: string, cwd: string) {
  const call = gitInvocation(source, cwd);
  if (!call) return;
  const { args } = call;
  if (
    args.length !== 4 ||
    args[0] !== "push" ||
    !(
      (args[1] === "origin" && args[2] === "--delete") ||
      (args[1] === "--delete" && args[2] === "origin")
    ) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(args[3]) ||
    args[3].includes("..")
  )
    return;
  return { ...call, branch: args[3] };
}

interface Scope extends Repository {
  targetBranch: string;
  defaultBranch: string;
  push: boolean;
  deletions: Map<string, string>;
}

/** Require ancestry or identical content on every path changed by the branch. */
async function integrated(cwd: string, tip: string, main: string) {
  const base = await git(cwd, ["merge-base", tip, main]);
  if (base === tip) return true;
  const paths = (
    await git(
      cwd,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
        base,
        tip,
      ],
      false,
      false,
    )
  )
    .split("\0")
    .filter(Boolean);
  if (paths.length > 1_000) return false;
  if (paths.length)
    await git(cwd, [
      "--literal-pathspecs",
      "diff",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      tip,
      main,
      "--",
      ...paths,
    ]);
  return true;
}

function quote(word: string) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function gitCommand(repo: Repository, args: string[]) {
  const overrides = Object.keys(process.env)
    .filter((key) => key.startsWith("GIT_"))
    .flatMap((key) => ["-u", key]);
  const words = [
    ...(overrides.length ? ["env", ...overrides] : []),
    "git",
    "--no-replace-objects",
    "-C",
    repo.root,
    ...args,
  ];
  return { words, command: words.map(quote).join(" ") };
}

function pinnedCommand(repo: Repository, args: string[]) {
  return gitCommand(repo, [
    "push",
    "--no-mirror",
    "--no-follow-tags",
    "--recurse-submodules=no",
    ...args,
  ]);
}

/** SHA refspecs cannot set upstream natively. Apply local bookkeeping after success. */
async function upstreamSetup(repo: Repository, branch: string, tip: string) {
  const fetchArgs = ["config", "--get-all", "remote.origin.fetch"];
  const fetch = await git(repo.root, fetchArgs, true);
  if (!/^\+?refs\/heads\/\*:refs\/remotes\/origin\/\*$/.test(fetch))
    throw Error("Unusual origin fetch mapping");
  const config = realpathSync(
    await git(repo.root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "config",
    ]),
  );
  const settings = [`branch.${branch}.remote`, `branch.${branch}.merge`];
  const checks: [string[], string][] = [
    [["remote", "get-url", "--push", "--all", "origin"], repo.remote],
    [fetchArgs, fetch],
  ];
  for (const key of settings) {
    const args = ["config", "--show-origin", "--get-all", key];
    const value = await git(repo.root, args, true);
    for (const line of value.split("\n").filter(Boolean)) {
      const source = line.slice(0, line.indexOf("\t"));
      if (
        !source.startsWith("file:") ||
        realpathSync(resolve(repo.root, source.slice(5))) !== config
      )
        throw Error("Tracking settings outside repository-local config");
    }
    checks.push([args, value]);
  }
  const ref = `refs/remotes/origin/${branch}`;
  if (await git(repo.root, ["symbolic-ref", "--quiet", ref], true))
    throw Error("Symbolic tracking ref");
  const previous =
    (await git(repo.root, ["rev-parse", "--verify", "--quiet", ref], true)) ||
    "0".repeat(tip.length);
  const unchanged = checks.map(
    ([args, value]) =>
      `test "$(${gitCommand(repo, args).command})" = ${quote(value)}`,
  );
  const directRef = `test -z "$(${gitCommand(repo, ["symbolic-ref", "--quiet", ref]).command})"`;
  const commands = [
    ...unchanged,
    directRef,
    gitCommand(repo, ["update-ref", "--no-deref", ref, tip, previous]).command,
    // Ref-transaction hooks can change config or redirect the tracking ref.
    // Check again before Git installs upstream with native locking semantics.
    ...unchanged,
    directRef,
    gitCommand(repo, ["branch", `--set-upstream-to=${ref}`, "--", branch])
      .command,
  ];
  return ` && { ${commands.join(" && ")} || { printf '%s\\n' 'Push succeeded. Upstream setup did not complete.' >&2; exit 1; }; }`;
}

/** Request-local grants, pinned per repository. Never persisted or inherited. */
export class PublishAuthorization {
  private generation = 0;
  private scopes = new Map<string, Scope>();

  get pending(): boolean {
    return [...this.scopes.values()].some(
      (scope) => scope.push || scope.deletions.size > 0,
    );
  }

  clear(): void {
    this.generation++;
    this.scopes.clear();
  }

  async request(text: string, ctx: ExtensionContext): Promise<void> {
    this.clear();
    const request = publishRequest(text);
    if (!request || !ctx.hasUI) return;
    const generation = this.generation;
    try {
      const paths = editedPaths(ctx);
      if (paths.length > 100) return;
      const roots = await Promise.all(
        [...new Set(paths.length ? paths.map(dirname) : [ctx.cwd])].map(
          repository,
        ),
      );
      const scopes = new Map<string, Scope>();
      for (const repo of roots) {
        const previous = scopes.get(repo.commonDir);
        if (previous) {
          if (
            previous.remote !== repo.remote ||
            (request.push &&
              !request.merge &&
              !request.branch &&
              previous.branch !== repo.branch)
          )
            return;
          continue;
        }
        const defaultBranch = (
          await git(
            repo.root,
            ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
            true,
          )
        ).replace(/^refs\/remotes\/origin\//, "");
        const targetBranch =
          request.branch || (request.merge ? defaultBranch : repo.branch);
        if (request.push && !targetBranch) return;
        const deletions = new Map<string, string>();
        if (request.cleanup && defaultBranch) {
          const refs = await git(repo.root, [
            "for-each-ref",
            "--format=%(refname:strip=3) %(objectname)",
            "refs/remotes/origin/",
          ]);
          for (const line of refs.split("\n")) {
            const [branch, tip] = line.split(" ");
            if (
              branch !== "HEAD" &&
              branch !== defaultBranch &&
              /^[a-f0-9]{40,64}$/.test(tip ?? "")
            )
              deletions.set(branch, tip);
          }
        }
        scopes.set(repo.commonDir, {
          ...repo,
          targetBranch,
          defaultBranch,
          push: request.push,
          deletions,
        });
      }
      if (generation === this.generation) this.scopes = scopes;
    } catch {
      /* Ambiguous scope keeps the ordinary confirmation. */
    }
  }

  private matches(current: Repository): Scope | undefined {
    const scope = this.scopes.get(current.commonDir);
    return scope?.remote === current.remote ? scope : undefined;
  }

  async consume(source: string, cwd: string) {
    const candidate = pushInvocation(source, cwd);
    if (!candidate || !this.pending) return;
    const generation = this.generation;
    try {
      const current = await repository(candidate.cwd);
      const scope = this.matches(current);
      if (
        generation !== this.generation ||
        !scope?.push ||
        candidate.branch !== scope.targetBranch ||
        current.branch !== candidate.branch
      )
        return;
      const tip = await git(current.root, [
        "rev-parse",
        "--verify",
        `refs/heads/${candidate.branch}^{commit}`,
      ]);
      const upstream = candidate.setUpstream
        ? await upstreamSetup(current, candidate.branch, tip)
        : "";
      if (
        generation !== this.generation ||
        this.matches(current) !== scope ||
        !scope.push
      )
        return;
      scope.push = false;
      const pinned = pinnedCommand(current, [
        "--",
        current.remote,
        `${tip}:refs/heads/${candidate.branch}`,
      ]);
      return { ...pinned, command: pinned.command + upstream };
    } catch {
      /* Failed validation must not become permission. */
    }
  }

  async consumeDeletion(source: string, cwd: string) {
    const candidate = deleteInvocation(source, cwd);
    if (!candidate || !this.pending) return;
    const generation = this.generation;
    try {
      const current = await repository(candidate.cwd);
      const scope = this.matches(current);
      const tip = scope?.deletions.get(candidate.branch);
      if (!scope || !tip || candidate.branch === current.branch) return;
      const ref = `refs/heads/${candidate.branch}`;
      const mainRef = `refs/heads/${scope.defaultBranch}`;
      if (
        (await git(current.root, [
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${candidate.branch}`,
        ])) !== tip
      )
        return;
      const main = await git(current.root, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${scope.defaultBranch}^{commit}`,
      ]);
      const worktrees = await git(current.root, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (
        worktrees.split("\n").includes(`branch ${ref}`) ||
        !(await integrated(current.root, tip, main))
      )
        return;
      const remote = await git(current.root, [
        "ls-remote",
        "--heads",
        "--",
        current.remote,
        ref,
        mainRef,
      ]);
      const refs = new Map(
        remote
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [sha, name] = line.split("\t");
            return [name, sha] as const;
          }),
      );
      if (refs.get(ref) !== tip || refs.get(mainRef) !== main) return;
      const final = await repository(candidate.cwd);
      if (
        generation !== this.generation ||
        this.matches(final) !== scope ||
        scope.deletions.get(candidate.branch) !== tip
      )
        return;
      scope.deletions.delete(candidate.branch);
      // The lease rejects an advanced branch even after the read-only checks finish.
      return pinnedCommand(current, [
        `--force-with-lease=${ref}:${tip}`,
        "--",
        current.remote,
        `:${ref}`,
      ]);
    } catch {
      /* Missing refs, failed proofs and remote errors retain confirmation. */
    }
  }
}
