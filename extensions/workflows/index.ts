import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPackageDir,
  getExamplesPath,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { initializeApproval, requireApproval } from "../approval/ready.ts";

type Task = {
  text: string;
  status: "pending" | "in-progress" | "done" | "blocked";
};
type State = { planning: boolean; tasks: Task[] };
const STATE = "dotfiles-workflows";

export function installedPackage(): string {
  if (process.env.PI_PARITY_PACKAGE_DIR)
    return process.env.PI_PARITY_PACKAGE_DIR;
  return getPackageDir();
}

export default async function workflows(pi: ExtensionAPI) {
  await initializeApproval(pi);
  let state: State = { planning: false, tasks: [] };
  let subagentError: string | undefined;

  function show(ctx: ExtensionContext) {
    pi.events.emit("dotfiles:plan-mode", state.planning);
    if (state.planning) {
      pi.setActiveTools([
        ...new Set([...pi.getActiveTools(), "grep", "find", "ls"]),
      ]);
    }
    if (!ctx.hasUI) return;
    const done = state.tasks.filter((task) => task.status === "done").length;
    ctx.ui.setStatus(
      "workflows",
      state.planning
        ? "plan: read-only"
        : state.tasks.length
          ? `tasks: ${done}/${state.tasks.length}`
          : undefined,
    );
    ctx.ui.setWidget(
      "workflows",
      state.tasks.length
        ? state.tasks.map(
            (task, index) => `${index + 1}. [${task.status}] ${task.text}`,
          )
        : undefined,
    );
  }
  function save(ctx: ExtensionContext) {
    pi.appendEntry(STATE, structuredClone(state));
    show(ctx);
  }
  function restore(ctx: ExtensionContext, startup = false) {
    state = { planning: false, tasks: [] };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const data = entry.data as State | undefined;
      if (
        typeof data?.planning === "boolean" &&
        Array.isArray(data.tasks) &&
        data.tasks.every(
          (task) =>
            task &&
            typeof task.text === "string" &&
            ["pending", "in-progress", "done", "blocked"].includes(task.status),
        )
      ) {
        state = structuredClone(data);
      } else {
        // A damaged saved plan must not silently restore execution mode.
        state = { planning: true, tasks: [] };
      }
    }
    if (startup && pi.getFlag("plan") === true) state.planning = true;
    show(ctx);
  }

  pi.registerFlag("plan", {
    description: "Start with mutating tools and Bash blocked",
    type: "boolean",
    default: false,
  });
  pi.registerCommand("plan", {
    description: "Toggle read-only planning: /plan [on|off|status]",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(value)) {
        ctx.ui.notify("Use /plan [on|off|status].", "error");
        return;
      }
      if (value !== "status") {
        state.planning = value === "on" || (value === "" && !state.planning);
        save(ctx);
      }
      ctx.ui.notify(
        state.planning
          ? "Plan mode on. Bash and mutating tools are blocked."
          : "Plan mode off. Approval checks still apply.",
        "info",
      );
    },
  });
  pi.registerCommand("todos", {
    description: "Show the current agent implementation checklist",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.tasks
          .map((task, index) => `${index + 1}. [${task.status}] ${task.text}`)
          .join("\n") || "No agent tasks yet.",
        "info",
      );
    },
  });
  pi.registerTool({
    name: "todo",
    label: "Agent tasks",
    description:
      "Track this agent's implementation steps. Set a checklist, update one numbered step, or list it. Track only agent tasks, not the user's personal commitments.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: Type.Object({
      action: StringEnum(["set", "update", "list"] as const),
      tasks: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 30 }),
      ),
      step: Type.Optional(Type.Integer({ minimum: 1 })),
      status: Type.Optional(
        StringEnum(["pending", "in-progress", "done", "blocked"] as const),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "set") {
        if (!params.tasks) throw new Error("set requires tasks.");
        state.tasks = params.tasks.map((text) => ({ text, status: "pending" }));
        save(ctx);
      } else if (params.action === "update") {
        if (!params.step || !params.status || !state.tasks[params.step - 1])
          throw new Error("update requires an existing step and status.");
        state.tasks[params.step - 1].status = params.status;
        save(ctx);
      }
      return {
        content: [
          {
            type: "text",
            text:
              state.tasks
                .map(
                  (task, index) =>
                    `${index + 1}. [${task.status}] ${task.text}`,
                )
                .join("\n") || "No tasks.",
          },
        ],
        details: structuredClone(state),
      };
    },
  });
  pi.on("session_start", (event, ctx) => {
    restore(ctx, event.reason === "startup");
    if (subagentError && ctx.hasUI) ctx.ui.notify(subagentError, "error");
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("tool_call", () => {
    if (requireApproval(pi).planning !== state.planning)
      return {
        block: true,
        reason: "Plan guard state is out of sync. Reload before continuing.",
      };
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.workflows = state.planning
      ? "Read-only planning is active. Inspect files with read/grep/find/ls. Do not use Bash or mutate external services. Produce a numbered implementation plan. /plan off enables execution."
      : "Use the todo tool to track multi-step implementation work. Mark blockers honestly. Do not turn the user's personal commitments into agent tasks.";
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode === "tui" && process.env.PI_NOTIFY !== "0")
      process.stdout.write("\x1b]777;notify;Pi;Ready for input\x07");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pi.events.emit("dotfiles:plan-mode", false);
    if (ctx.hasUI) {
      ctx.ui.setWidget("workflows", undefined);
      ctx.ui.setStatus("workflows", undefined);
    }
  });

  const source = join(
    process.env.PI_PARITY_PACKAGE_DIR
      ? join(installedPackage(), "examples")
      : getExamplesPath(),
    "extensions",
    "subagent",
    "index.ts",
  );
  try {
    if (!existsSync(source)) throw new Error("missing example");
    const { default: subagent } = await import(pathToFileURL(source).href);
    await subagent(pi);
  } catch {
    // Retain plan enforcement if an installed distribution lacks the example.
    subagentError =
      "The installed Pi subagent example could not be loaded. Planning and approval remain active.";
  }
}
