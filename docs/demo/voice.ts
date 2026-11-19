import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installVoice } from "../../extensions/voice/index.ts";
import vim from "../../extensions/vim/index.ts";
import { createDemoWorker } from "./voice-worker.mjs";

// Exercise the shipped Voice controller/editor with explicitly simulated speech.
// This entrypoint is never included in package.pi.extensions.
export default function voiceDemo(pi: ExtensionAPI) {
  // Prevent Pi's missing-model warning from exposing its installation path.
  pi.registerProvider("demo", {
    baseUrl: "https://example.invalid",
    apiKey: "demo",
    api: "openai-completions",
    models: [
      {
        id: "demo",
        name: "Demo (no calls)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 512,
      },
    ],
  });
  pi.on("input", () => ({ action: "handled" }));
  vim(pi);
  installVoice(pi, {
    supported: () => true,
    createWorker: createDemoWorker,
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("voice-demo-label", [
      "DEMO · simulated speech · no microphone or speech model",
      "Ctrl+Space: record / stop. Review the final prompt before sending.",
    ]);
  });
}
