import { readFileSync } from "node:fs";
import { join } from "node:path";

const name = { claude: "Claude", pi: "Pi", codex: "Codex" }[process.argv[2]];
const root = process.env.PI_DEMO_COMMS_ROOT;
if (!name || !root || !process.stdin.isTTY)
  throw new Error("This fixture requires the Comms demo terminal.");
const label = `DEMO · Mock ${name}`;
console.log(
  `${label}\n\nNew session. No prompt received.\n\nCtrl+V · paste fixture context`,
);
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  if (!data.includes(22)) return; // Ctrl+V is the explicit fixture paste.
  const prompt = readFileSync(join(root, "clipboard.txt"), "utf8");
  const preview = prompt.slice(prompt.indexOf("\n\n") + 2);
  console.log(
    `\x1b[2J\x1b[H${label}\nPasted by hand · not submitted\n\n${preview}`,
  );
});
