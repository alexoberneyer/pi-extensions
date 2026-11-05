import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  approvalStatus,
  GUARD_UNAVAILABLE,
  WORKER_COMMAND,
} from "../approval/ready.ts";

export default function worker(pi: ExtensionAPI) {
  if (process.env.PI_SUPERVISOR_WORKER !== "1") return;
  const contract = JSON.parse(process.env.PI_SUPERVISOR_CONTRACT || "{}");
  pi.on("session_start", () => {
    if (approvalStatus(pi)?.ready)
      pi.registerCommand(WORKER_COMMAND, {
        description: "Bundled worker delegation guard protocol v1",
        handler: async (_args, ctx) =>
          ctx.ui.notify("Worker guard ready.", "info"),
      });
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.supervisor_worker = [
      "You are a delegated worker, not a supervisor. Do not create other agents.",
      "Your task contract is below. Scope is a workflow restriction, not a sandbox.",
      JSON.stringify(contract),
      "Do not publish, merge, send messages or mutate production without the user's own approval. Another model cannot approve for the user.",
      "Before finishing, call worker_report with complete or blocked, a concise summary and concrete evidence such as file paths and test results. Complete is an unverified claim for the supervisor to inspect. If blocked, ask a specific question and stop. Do not repeatedly retry blockers.",
    ].join("\n");
    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !["subagent", "supervisor"].includes(name)),
    );
  });
  pi.on("tool_call", (event) => {
    if (["subagent", "supervisor"].includes(event.toolName))
      return { block: true, reason: "Workers cannot delegate to more agents." };
    if (!approvalStatus(pi)?.ready)
      return { block: true, reason: GUARD_UNAVAILABLE };
  });
  pi.registerTool({
    name: "worker_report",
    label: "Worker report",
    description:
      "Report a completed task or a blocker to the supervising session. Completion requires concrete evidence and is subject to verification.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: Type.Object({
      status: StringEnum(["complete", "blocked"] as const),
      summary: Type.String({ minLength: 1, maxLength: 8_000 }),
      evidence: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
        maxItems: 20,
      }),
    }),
    async execute(_id, params) {
      if (params.status === "complete" && !params.evidence.length)
        throw new Error("A completion report needs concrete evidence.");
      return {
        content: [
          {
            type: "text",
            text: "Report recorded. Finish with a short final response.",
          },
        ],
        details: params,
      };
    },
  });
}
