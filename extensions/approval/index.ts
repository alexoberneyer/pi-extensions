import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellCommands, type ShellCommand } from "./shell.js";
import { PublishAuthorization } from "./publish.ts";
import { recordApproval, type ApprovalRecord } from "./audit.ts";
import { ownedTempCleanup } from "./temp-cleanup.ts";
import { readConfig } from "../../lib/config.mjs";
import {
  APPROVAL_COMMAND,
  APPROVAL_QUERY,
  APPROVAL_READY,
  GUARD_UNAVAILABLE,
  approvalStatus,
} from "./ready.ts";

interface RiskPolicy {
  protectedCommands?: readonly string[];
  readCommands?: readonly string[];
  allowPublish?: (command: ShellCommand) => boolean;
  onTempCleanup?: (count: number) => void;
}
const nestedPolicy = (policy?: RiskPolicy): RiskPolicy => ({
  protectedCommands: policy?.protectedCommands,
  readCommands: policy?.readCommands,
  onTempCleanup: policy?.onTempCleanup,
});

// Reviewed operations, not server-wide or verb-based exemptions. REA search
// records session evidence, so its server intentionally marks it non-read-only.
const reviewedInspections = new Set([
  "mcp__notion_api__API_query_data_source",
  "mcp__rea__search_strings",
]);

const readCommands = new Set([
  "get",
  "list",
  "search",
  "status",
  "show",
  "view",
  "describe",
  "help",
  "--help",
  "--version",
  "version",
]);

function positional(words: string[], valueFlags: string[] = []): string[] {
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) {
    const flag = words[i++];
    if (flag === "--") break;
    if (valueFlags.includes(flag)) i++;
  }
  return words.slice(i);
}

function invocation(words: string[]): string[] {
  words = [...words];
  while (words.length) {
    if (
      /^[\w]+=.*/.test(words[0]) ||
      /^(?:if|then|else|elif|do|while|until|!|\{|\})$/.test(words[0])
    ) {
      words.shift();
    } else if (
      ["env", "command", "exec", "time", "nohup"].includes(basename(words[0]))
    ) {
      if (basename(words[0]) === "env") {
        const split = words.findIndex((word) =>
          /^(?:-S|--split-string(?:=|$))/.test(word),
        );
        if (split !== -1) {
          const flag = words[split];
          const separate = flag === "-S" || flag === "--split-string";
          const source = separate
            ? (words[split + 1] ?? "")
            : flag.slice(flag.startsWith("-S") ? 2 : "--split-string=".length);
          words = [
            ...words.slice(0, split),
            ...(shellCommands(source)[0]?.words ?? []),
            ...words.slice(split + (separate ? 2 : 1)),
          ];
        }
      }
      words = positional(words.slice(1), [
        "-u",
        "--unset",
        "-C",
        "--chdir",
        "-a",
      ]);
    } else if (basename(words[0]) === "nice") {
      words = positional(words.slice(1), ["-n", "--adjustment"]);
    } else break;
  }
  return words;
}

function outputText(command: ShellCommand): string[] {
  if (command.group) return command.group.flatMap(outputText);
  const [name, ...args] = invocation(command.words);
  const output =
    basename(name ?? "") === "printf"
      ? [args[0] ?? "", args.slice(1).join(" ")]
      : [args.join(" ")];
  return [...stdinText(command), ...output];
}

function stdinText(command: ShellCommand): string[] {
  // Conservatively inspect producer text. Do not try to run or emulate a pipe.
  return [
    ...command.input,
    ...(command.upstream ? outputText(command.upstream) : []),
  ];
}

function codeRisk(script: string, policy?: RiskPolicy): string | undefined {
  const direct = commandRisk(script, nestedPolicy(policy));
  if (direct) return direct;
  // Inline interpreter code is opaque. Retain checks for literal shell snippets.
  for (const command of shellCommands(script)) {
    for (const word of command.words) {
      if (!/\s/.test(word)) continue;
      const risk = commandRisk(word, nestedPolicy(policy));
      if (risk) return risk;
    }
  }
  return undefined;
}

function invocationRisk(
  command: ShellCommand,
  policy?: RiskPolicy,
): string | undefined {
  const words = invocation(command.words);
  const input = stdinText(command);
  const name = basename(words[0] ?? "");
  const args = words.slice(1);
  if (
    ["sudo", "doas"].includes(name) ||
    (name === "rm" &&
      args.some((arg) => /^-[\w]*[rf]|^--recursive$/.test(arg))) ||
    (["chmod", "chown"].includes(name) && args.includes("777"))
  )
    return "Destructive filesystem or privileged command";

  if (policy?.protectedCommands?.includes(name)) {
    const verbs = args.slice(0, 2);
    if (
      verbs.some((word) =>
        /^(?:create|update|cancel|confirm|accept|book|initialize|execute|delete|remove)$/.test(
          word,
        ),
      )
    )
      return "Change data through a protected command";
    const reviewedRead = (word: string) =>
      readCommands.has(word) || policy.readCommands?.includes(word);
    if (
      !reviewedRead(args[0]) &&
      !(/^[A-Za-z0-9][\w.-]*$/.test(args[0] ?? "") && reviewedRead(args[1]))
    )
      return "Protected command not recognized as read-only";
  }

  if (name === "trap" && args[0] && !["-p", "-l", "-"].includes(args[0])) {
    const body = args[0] === "--" ? args[1] || "" : args[0];
    if (body.startsWith("$")) return "Undecoded or dynamic shell trap body";
    return commandRisk(body, nestedPolicy(policy));
  }
  if (name === "eval") return commandRisk(args.join(" "), nestedPolicy(policy));
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(name)) {
    const flag = args.findIndex(
      (arg) => /^-[^-]*c/.test(arg) || arg === "--command",
    );
    for (const script of [
      ...(flag === -1 ? [] : [args[flag + 1] ?? ""]),
      ...input,
    ]) {
      const risk = commandRisk(script, nestedPolicy(policy));
      if (risk) return risk;
    }
    return;
  }
  if (
    /^(?:node|nodejs|bun|deno|python(?:[23](?:\.\d+)?)?|ruby|perl)$/.test(name)
  ) {
    const flag = args.findIndex((arg) =>
      /^(?:-e|-p|-c|--eval|--print)$/.test(arg),
    );
    for (const script of [
      ...(flag === -1 ? [] : [args[flag + 1] ?? ""]),
      ...input,
    ]) {
      const risk = codeRisk(script, nestedPolicy(policy));
      if (risk) return risk;
    }
  }
  if (name === "ssh") {
    const remote = positional(args, [
      "-o",
      "-p",
      "-i",
      "-F",
      "-J",
      "-l",
      "-L",
      "-R",
      "-D",
      "-S",
      "-W",
      "-w",
      "-E",
      "-b",
      "-c",
      "-m",
    ]);
    const script = remote.slice(1).join(" ");
    const risk = commandRisk(script, nestedPolicy(policy));
    if (risk) return risk;
    if (
      !script ||
      shellCommands(script).some((command) =>
        /^(?:bash|sh|zsh|dash|ksh|psql|mysql|sqlite3|bq)$/.test(
          basename(invocation(command.words)[0] ?? ""),
        ),
      )
    ) {
      for (const body of input) {
        const risk = commandRisk(body, nestedPolicy(policy));
        if (risk) return risk;
      }
    }
    return;
  }
  if (name === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!/^-exec(?:dir)?$|^-ok(?:dir)?$/.test(args[i])) continue;
      const end = args.findIndex((arg, j) => j > i && [";", "+"].includes(arg));
      const risk = invocationRisk(
        {
          words: args.slice(i + 1, end === -1 ? undefined : end),
          input: [],
        },
        nestedPolicy(policy),
      );
      if (risk) return risk;
    }
    return;
  }
  if (name === "xargs")
    return invocationRisk(
      {
        words: positional(args, [
          "-I",
          "-n",
          "-P",
          "-L",
          "-s",
          "-E",
          "--replace",
          "--max-args",
          "--max-procs",
          "--max-lines",
          "--max-chars",
          "--eof",
        ]),
        input: [],
      },
      nestedPolicy(policy),
    );

  if (name === "git") {
    const [verb, ...options] = positional(args, [
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--config-env",
    ]);
    if (verb === "push" && policy?.allowPublish?.(command)) return;
    if (
      (verb === "reset" && options.includes("--hard")) ||
      (verb === "clean" && options.some((arg) => /^-[\w]*[fx]/.test(arg))) ||
      (verb === "push" &&
        options.some((arg) =>
          /^(?:--force(?:=|$)|--force-with-lease(?:=|$)|-f$|--mirror$|--delete$)/.test(
            arg,
          ),
        ))
    )
      return "Destructive Git operation";
    if (verb === "push") return "Publish repository changes";
    return;
  }
  if (
    ["terraform", "kubectl", "gcloud", "bq"].includes(name) &&
    /\b(?:terraform\s+(?:apply|destroy)|kubectl\b.*\b(?:apply|delete|replace|patch)|gcloud\b.*\b(?:deploy|delete)|bq\s+(?:rm|load|cp))\b/i.test(
      [name, ...args].join(" "),
    )
  )
    return "Change cloud or production resources";

  if (name === "gh") {
    const [entity, verb] = positional(args, ["-R", "--repo", "--hostname"]);
    if (
      /^(?:issue|pr|release)$/.test(entity ?? "") &&
      /^(?:create|comment|edit|merge|close|delete)$/.test(verb ?? "")
    )
      return "Publish or change remote data";
    return;
  }
  if (
    name === "curl" &&
    args.some(
      (arg, i) =>
        (/^(?:-X|--request)$/.test(arg) &&
          /^(?:POST|PUT|PATCH|DELETE)$/.test(args[i + 1] ?? "")) ||
        /^--request=(?:POST|PUT|PATCH|DELETE)$/.test(arg) ||
        /^-[0-9#qfsSkvLiINgG]*X(?:POST|PUT|PATCH|DELETE)$/.test(arg) ||
        (/^-[0-9#qfsSkvLiINgG]*X$/.test(arg) &&
          /^(?:POST|PUT|PATCH|DELETE)$/.test(args[i + 1] ?? "")),
    )
  )
    return "Publish or change remote data";

  // Inspection arguments and literal output are data, not SQL to execute.
  if (
    !["rg", "grep", "ls", "cat", "head", "tail", "printf", "echo"].includes(
      name,
    ) &&
    /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i.test(
      [name, ...args, ...input].join(" "),
    )
  )
    return "Database mutation";
  return undefined;
}

export function commandRisk(
  command: string,
  policy?: RiskPolicy,
): string | undefined {
  const cleanup = ownedTempCleanup(command);
  if (cleanup.count) policy?.onTempCleanup?.(cleanup.count);
  for (const invocation of shellCommands(cleanup.source)) {
    const risk = invocationRisk(
      invocation,
      invocation.nested ? nestedPolicy(policy) : policy,
    );
    if (risk) return risk;
  }
  return undefined;
}

export function pathRisk(path: string): string | undefined {
  if (
    /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.claude\.json|auth\.json|mcp(?:-auth)?\.json|web\.json|credentials(?:\.[^/\\]*)?|\.git)(?:[/\\]|$)/.test(
      path,
    )
  ) {
    return "Edit credentials or Git internals";
  }
  return undefined;
}

export default function approval(pi: ExtensionAPI) {
  // Factories receive different API objects. Deduplicate through the shared bus,
  // not a module singleton or WeakSet tied to one loader's imports.
  if (approvalStatus(pi)) return;
  let protectedCommands: string[] = [];
  let configuredReads: string[] = [];
  let configured = false;
  try {
    const config = readConfig().approval;
    protectedCommands = config.protectedCommands;
    configuredReads = config.readCommands;
    configured = true;
  } catch {
    // Retain the guard and deny all tool calls on invalid configuration.
  }
  let planning = false;
  const publication = new PublishAuthorization();
  const stop = pi.events.on("dotfiles:plan-mode", (data: unknown) => {
    const next = data === true;
    if (next !== planning) publication.clear();
    planning = next;
  });
  pi.on("input", async (event, ctx) => {
    publication.clear();
    if (
      !planning &&
      process.env.PI_SUPERVISOR_WORKER !== "1" &&
      event.source !== "extension" &&
      !event.streamingBehavior
    )
      await publication.request(event.text, ctx);
  });
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") {
      publication.clear();
      return;
    }
    if (publication.pending)
      event.systemPromptOptions.promptGuidelines.push(
        "For explicitly requested Git publishing, use a separate standalone git -C <repo> push origin <branch> command per repository. For requested stale-branch cleanup, use standalone git -C <repo> push origin --delete <branch> commands. The guard verifies staleness and adds an exact-tip lease. Compound shell commands, wrappers and unverified destructive pushes still require confirmation.",
      );
  });
  pi.on("agent_settled", () => publication.clear());
  pi.on("session_start", () => publication.clear());
  pi.on("session_before_switch", () => publication.clear());
  pi.on("session_before_fork", () => publication.clear());
  pi.on("session_before_tree", () => publication.clear());
  pi.on("session_tree", () => publication.clear());
  pi.on("session_shutdown", () => {
    publication.clear();
    stop();
    offReady();
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!configured) return { block: true, reason: GUARD_UNAVAILABLE };
    const log = (
      phase: ApprovalRecord["phase"],
      reason: string,
      outcome?: ApprovalRecord["outcome"],
    ) => {
      try {
        recordApproval(
          ctx,
          event,
          { phase, reason, ...(outcome ? { outcome } : {}) },
          (record) => pi.appendEntry("dotfiles-approval", record),
        );
      } catch {
        throw Error(
          "Approval audit unavailable. Tool blocked rather than allowing an unlogged decision.",
        );
      }
    };
    const block = (reason: string) => {
      log("decision", reason, "blocked");
      return { block: true, reason };
    };
    const tool = pi.getAllTools().find((item) => item.name === event.toolName);
    const hints = tool?.annotations;
    const isInspection =
      hints?.readOnlyHint === true || reviewedInspections.has(event.toolName);
    const isMcp = event.toolName.startsWith("mcp__");
    const method = event.toolName.split("__").slice(2).join("__");
    const mailSend =
      isMcp && /send.*(?:mail|email)|(?:mail|email).*send/i.test(method);
    const chatSend =
      isMcp &&
      /(?:send|post|create).*chat.*message|chat.*message.*(?:send|post|create)/i.test(
        method,
      );
    if (mailSend)
      return block("Email is draft-only. Create a draft instead of sending.");
    const isRead = [
      "read",
      "grep",
      "find",
      "ls",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ].includes(event.toolName);
    const isOrchestrator = ["codemode", "tool_search"].includes(event.toolName);
    let reason: string | undefined;

    if (planning) {
      if (event.toolName === "bash") {
        return block(
          "Plan mode: Bash is disabled. Use read/grep/find/ls for inspection.",
        );
      }
      if (
        chatSend ||
        hints?.destructiveHint === true ||
        (!isRead &&
          !isOrchestrator &&
          event.toolName !== "todo" &&
          !isInspection)
      ) {
        return block(
          "Plan mode: mutating or unclassified tool blocked. Run /plan off to execute.",
        );
      }
    }
    let granted: string[] | undefined;
    let deletion = false;
    let cleanupCount = 0;
    if (event.toolName === "bash") {
      let command = String(event.input.command ?? "");
      if (ctx.hasUI && !event.parentToolCallId) {
        const push = await publication.consume(command, ctx.cwd);
        const cleanup = push
          ? undefined
          : await publication.consumeDeletion(command, ctx.cwd);
        const grant = push ?? cleanup;
        if (grant) {
          granted = grant.words;
          command = grant.command;
          event.input.command = command;
          deletion = Boolean(cleanup);
        }
      }
      let used = false;
      reason = commandRisk(command, {
        protectedCommands,
        readCommands: configuredReads,
        allowPublish: (candidate) => {
          if (
            !used &&
            granted &&
            JSON.stringify(candidate.words) === JSON.stringify(granted)
          ) {
            used = true;
            return true;
          }
          return false;
        },
        onTempCleanup: (count) => {
          cleanupCount += count;
        },
      });
    }
    if (["edit", "write"].includes(event.toolName))
      reason = pathRisk(String(event.input.path ?? ""));
    if (isMcp && (!isInspection || hints?.destructiveHint === true))
      reason = "MCP mutation or tool without a read-only annotation";
    if (chatSend) reason = "Confirm this outgoing chat message";
    if (!reason) {
      if (granted)
        log(
          "decision",
          deletion
            ? "Delete verified stale branch"
            : "Publish repository changes",
          "explicit-request",
        );
      else if (cleanupCount)
        log(
          "decision",
          "Verified same-script temporary file cleanup",
          "owned-temp-cleanup",
        );
      return;
    }

    if (!ctx.hasUI)
      return block(`${reason}: approval required, but no UI is available.`);
    const summary =
      event.toolName === "bash"
        ? String(event.input.command ?? "").slice(0, 1200)
        : isMcp
          ? `${event.toolName}\n\n${JSON.stringify(event.input, null, 2)}`
          : `${event.toolName}${typeof event.input.path === "string" ? ` · ${basename(event.input.path)}` : ""}`;
    log("prompt", reason);
    let accepted: boolean;
    try {
      accepted = await ctx.ui.confirm(reason, summary);
    } catch (error) {
      log("decision", reason, "error");
      throw error;
    }
    log("decision", reason, accepted ? "allowed" : "denied");
    if (!accepted) return { block: true, reason: "Not approved by the user." };
  });
  // Advertise only after every guard hook has been registered. No model call is
  // needed to verify this marker through RPC get_commands.
  if (configured)
    pi.registerCommand(APPROVAL_COMMAND, {
      description: "Bundled approval guard protocol v1",
      handler: async (_args, ctx) => {
        ctx.ui.notify("Approval guard ready.", "info");
      },
    });
  const offReady = pi.events.on(APPROVAL_QUERY, (data: any) => {
    pi.events.emit(APPROVAL_READY, {
      id: data?.id,
      version: 1,
      ready: configured,
      planning,
    });
  });
}
