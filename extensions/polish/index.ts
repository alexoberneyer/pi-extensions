import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expandPath, readConfig } from "../../lib/config.mjs";

export const DEFAULT_RULES = "~/.agents/skills/polish-text/rules.md";
const OUTPUT =
  "Return only the polished text. The text to polish follows in the user message.";

type Outcome =
  | { text: string }
  | { cancelled: true }
  | { error: string }
  | undefined;

/** Polish a draft with one side request and put the result in the prompt box. */
export function installPolish(
  pi: ExtensionAPI,
  {
    config = readConfig().polish,
    readRules = (path: string) => readFileSync(path, "utf8"),
  } = {},
) {
  const rulesPath = expandPath(config.rulesFile ?? DEFAULT_RULES);
  let running = false;

  function resolveModel(ctx: ExtensionContext): Model<Api> | undefined {
    if (!config.model) return ctx.model;
    const slash = config.model.indexOf("/");
    return ctx.modelRegistry.find(
      config.model.slice(0, slash),
      config.model.slice(slash + 1),
    );
  }

  async function request(
    ctx: ExtensionContext,
    model: Model<Api>,
    rules: string,
    draft: string,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const message = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: `${rules.trim()}\n\n${OUTPUT}`,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: draft }],
              timestamp: Date.now(),
            },
          ],
        },
        { signal, ...(model.reasoning ? { reasoning: "low" as const } : {}) },
      )
      .result();
    if (message.stopReason === "aborted") return { cancelled: true };
    if (message.stopReason === "error")
      return { error: message.errorMessage || "the model request failed" };
    if (message.stopReason === "length")
      return { error: "the reply was cut off" };
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    return text ? { text } : { error: "the model returned no text" };
  }

  async function polish(ctx: ExtensionContext, input: string) {
    if (ctx.mode !== "tui") return;
    const draft = input.trim();
    if (!draft)
      return ctx.ui.notify(
        `Nothing to polish. Type or dictate a draft, then press ${config.shortcut}.`,
        "warning",
      );
    if (running) return ctx.ui.notify("Polish is already running.", "warning");
    let rules: string;
    try {
      rules = readRules(rulesPath);
    } catch {
      return ctx.ui.notify(
        `Cannot read the polish rules at ${rulesPath}. Set polish.rulesFile.`,
        "error",
      );
    }
    const model = resolveModel(ctx);
    if (!model)
      return ctx.ui.notify(
        config.model
          ? `Polish model ${config.model} is not available.`
          : "Select a model first.",
        "error",
      );
    running = true;
    let outcome: Outcome;
    try {
      outcome = await ctx.ui.custom<Outcome>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          `Polishing with ${model.id}...`,
        );
        loader.onAbort = () => done({ cancelled: true });
        request(ctx, model, rules, draft, loader.signal).then(done, (error) =>
          done({ error: error instanceof Error ? error.message : "failed" }),
        );
        return loader;
      });
    } finally {
      running = false;
    }
    if (!outcome || "cancelled" in outcome)
      return ctx.ui.notify("Polish cancelled. The draft is unchanged.", "info");
    if ("error" in outcome)
      return ctx.ui.notify(
        `Polish failed: ${outcome.error}. The draft is unchanged.`,
        "error",
      );
    ctx.ui.setEditorText(outcome.text);
    ctx.ui.notify("Polished. Undo restores your draft.", "info");
  }

  pi.registerCommand("polish", {
    description: "Polish text into the prompt box without sending it",
    handler: (args, ctx) => polish(ctx, args),
  });
  pi.registerShortcut(config.shortcut, {
    description: "Polish the draft in the prompt box",
    handler: (ctx) => polish(ctx, ctx.ui.getEditorText()),
  });
}

export default function (pi: ExtensionAPI) {
  installPolish(pi);
}
