import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readConfig } from "../../lib/config.mjs";

// Keep the original state key so saved Astra settings still restore.
const STATE = "astra-fast";
type FastTier = "off" | "priority" | "ultrafast";

export default function (pi: ExtensionAPI) {
  const defaultTier = readConfig().fast.defaultTier as FastTier;
  let tier: FastTier = defaultTier;

  function supportsFast(ctx: ExtensionContext) {
    return (
      (ctx.model?.provider === "openai-codex" &&
        ctx.model.api === "openai-codex-responses" &&
        ["gpt-6-astra", "gpt-6.1-sol"].includes(ctx.model.id)) ||
      (ctx.model?.provider === "openai" &&
        ctx.model.api === "openai-responses" &&
        ctx.model.id === "gpt-6.1-sol")
    );
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      STATE,
      supportsFast(ctx)
        ? `fast: ${tier === "ultrafast" ? "ultra (requested)" : tier === "priority" ? "on" : "off"}`
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
    if (tier === "off" || !supportsFast(ctx)) return;
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
      "Set Astra/Sol speed tier (increased usage): /fast [on|off|ultra|status]",
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
      const scope = supportsFast(ctx)
        ? ""
        : " Inactive on this model. Supports openai-codex/gpt-6-astra and openai or openai-codex/gpt-6.1-sol.";
      const setting =
        tier === "ultrafast"
          ? "Ultrafast requested. Availability depends on provider and account. Increased allowance consumption and charges may apply. API keys are billed separately. Pi's displayed cost can underestimate actual provider charges. Verify current pricing before use."
          : `Fast ${tier === "priority" ? "on: requests priority tier, with increased usage" : "off"}.`;
      ctx.ui.notify(
        `${setting}${scope} Reasoning unchanged.`,
        tier === "ultrafast" ? "warning" : "info",
      );
    },
  });
}
