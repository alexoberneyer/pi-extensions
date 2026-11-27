import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installComms } from "../../extensions/comms/index.ts";
import { demoState } from "../../extensions/comms/state.ts";
import { Store } from "../../extensions/comms/store.ts";

// Recording only. Real queue and handoff UI with synthetic state and clipboard.
export default async function commsDemo(pi: ExtensionAPI) {
  const root = process.env.PI_DEMO_COMMS_ROOT;
  if (!root || getAgentDir() !== join(root, "pi"))
    throw new Error("Start this fixture using comms-world.mjs.");
  new Store(join(getAgentDir(), "comms")).update((state) => {
    const sample = demoState();
    sample.items[0].summary = "Can you review the rollout plan by Friday?";
    sample.items[0].draft = "I can review the rollout plan by Friday.";
    state.items = sample.items;
    state.coverage = sample.coverage;
  });
  pi.on("input", () => ({ action: "handled" }));
  await installComms(pi, {
    copy: async (text) => {
      writeFileSync(join(root, "clipboard.txt"), text, { mode: 0o600 });
    },
  });
}
