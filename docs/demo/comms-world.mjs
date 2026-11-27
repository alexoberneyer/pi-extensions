import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorld, quote, startWatchdog } from "./world.mjs";

const mockAgent = fileURLToPath(new URL("./comms-agent.mjs", import.meta.url));
const extension = fileURLToPath(new URL("./comms.ts", import.meta.url));

export function createCommsWorld() {
  const world = createWorld("comms");
  world.env.PI_DEMO_COMMS_ROOT = world.root;
  // All picker choices are fixtures. Only the outer TUI uses the real Pi.
  for (const agent of ["claude", "pi", "codex"])
    writeFileSync(
      join(world.root, "bin", agent),
      `#!/bin/sh\n[ "$#" -eq 0 ] || exit 1\nexec ${quote(process.execPath)} ${quote(mockAgent)} ${quote(agent)}\n`,
      { mode: 0o700 },
    );
  for (const command of ["open", "osascript", "uv", "pbcopy", "pbpaste"])
    writeFileSync(join(world.root, "bin", command), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
  return world;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.platform !== "darwin")
    throw new Error("The Comms split demo requires macOS and tmux.");
  const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const world = createCommsWorld();
  startWatchdog(world);
  const result = spawnSync(
    "tmux",
    [
      "-f",
      "/dev/null",
      "new-session",
      "-s",
      "comms-demo",
      "-c",
      world.project("shop-api"),
      pi,
      "-ne",
      "-ns",
      "-nc",
      "-np",
      "--no-themes",
      "--no-mcp",
      "--offline",
      "--no-session",
      "-e",
      extension,
      ";",
      "set-option",
      "-g",
      "status-format[0]",
      " DEMO · Synthetic queue and mock agent",
      ";",
      "set-option",
      "-g",
      "status-style",
      "fg=colour250,bg=colour235",
    ],
    { env: world.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
