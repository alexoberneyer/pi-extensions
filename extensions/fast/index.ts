import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readConfig } from "../../lib/config.mjs";

// Keep the original state key so saved Astra settings still restore.
const STATE = "astra-fast";
type FastTier = "off" | "priority" | "ultrafast";
const TIER_LABEL = { off: "Off", priority: "Fast", ultrafast: "Ultrafast" };

function supportsFast(model: ExtensionContext["model"]) {
  if (!model) return false;
  const { provider, api, id } = model;
  const codex = provider === "openai-codex" && api === "openai-codex-responses";
  if (!codex && !(provider === "openai" && api === "openai-responses")) {
    return false;
  }
  if (id === "gpt-6.1-sol" || (codex && id === "gpt-6-astra")) return true;

  // Pi's catalog does not expose speed tier capabilities. Match the known
  // model families from 6.2 onward, not arbitrary newer GPT models.
  const release =
    /^gpt-(\d+)(?:\.(\d+))?-(?:astra|sol)(?:-\d{4}-\d{2}-\d{2})?$/.exec(id);
  if (!release) return false;
  const major = Number(release[1]);
  return major > 6 || (major === 6 && Number(release[2] ?? 0) >= 2);
}

export default function (pi: ExtensionAPI) {
  const defaultTier = readConfig().fast.defaultTier as FastTier;
  let tier: FastTier = defaultTier;

  function describeStatus(ctx: ExtensionContext) {
    const configured = `Configured: ${TIER_LABEL[tier]}.`;
    if (tier === "off") return `${configured} No service tier override.`;
    const model = ctx.model;
    if (!model) return `${configured} Inactive: no model selected.`;
    const name = `${model.provider}/${model.id}`;
    if (!supportsFast(model)) {
      return `${configured} Inactive on this model (${name}). No service tier override.`;
    }
    const active = `${configured} Active on ${name}: requests ${tier}. Availability depends on provider and account.`;
    return tier === "priority" ? `${active} Fast has increased usage.` : active;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      STATE,
      supportsFast(ctx.model)
        ? `fast: ${tier === "ultrafast" ? "ultra (requested)" : tier === "priority" ? "on (requested)" : "off"}`
        : undefined,
    );
  }

  function restore(ctx: ExtensionContext) {
    tier = defaultTier;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const data = entry.data as
        | { enabled?: unknown; tier?: unknown }
        | undefined;
      if (
        data?.tier === "off" ||
        data?.tier === "priority" ||
        data?.tier === "ultrafast"
      ) {
        tier = data.tier;
      } else if (typeof data?.enabled === "boolean") {
        tier = data.enabled ? "priority" : "off";
      }
    }
    updateStatus(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATE, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (tier === "off" || !supportsFast(ctx.model)) return;
    const payload = event.payload;
    // Check the actual request too: compaction can use a different model.
    if (
      !payload ||
      typeof payload !== "object" ||
      !("model" in payload) ||
      payload.model !== ctx.model?.id
    ) {
      return;
    }
    return { ...payload, service_tier: tier };
  });

  pi.registerCommand("fast", {
    description:
      "Set OpenAI speed tier (increased usage): /fast [on|off|ultra|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "ultra", "status"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|ultra|status]", "error");
        return;
      }
      if (action !== "status") {
        tier =
          action === "ultra"
            ? "ultrafast"
            : action === "on" || (action === "" && tier === "off")
              ? "priority"
              : "off";
        pi.appendEntry(STATE, { enabled: tier !== "off", tier });
      }
      updateStatus(ctx);
      const ultra = tier === "ultrafast";
      const warning = ultra
        ? " Increased allowance consumption and charges may apply when requested. API keys are billed separately. Pi's displayed cost can underestimate actual provider charges."
        : "";
      ctx.ui.notify(
        `${describeStatus(ctx)}${warning}`,
        ultra ? "warning" : "info",
      );
    },
  });
}
