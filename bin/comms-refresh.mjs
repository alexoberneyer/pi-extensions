#!/usr/bin/env node
// Runs one Comms refresh outside Pi, or installs it as a weekday launchd job.
//   comms-refresh.mjs               one refresh now
//   comms-refresh.mjs install 07:00 weekday job (macOS), runs after wake if missed
//   comms-refresh.mjs uninstall     remove the job
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "local.pi-comms-refresh";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

// The installed Pi package carries the TypeScript loader and peer modules.
function piPackage() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const managed =
    process.env.PI_MANAGED_INSTALL_ROOT ||
    join(homedir(), ".pi", "agent", "install");
  const versionFile = join(managed, "current-version");
  if (existsSync(versionFile)) {
    const version = readFileSync(versionFile, "utf8").trim();
    if (!/^[\w.-]+$/.test(version))
      throw new Error("Invalid managed Pi version.");
    return join(
      managed,
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
  }
  const global = execFileSync("npm", ["root", "-g"], { encoding: "utf8" });
  return join(global.trim(), "@earendil-works", "pi-coding-agent");
}
async function agentDir(packageDir) {
  const { getAgentDir } = await import(
    pathToFileURL(join(packageDir, "dist", "config.js")).href
  );
  return getAgentDir();
}
function which(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Not in this directory. */
    }
  }
  throw new Error(`${name} is not on PATH. Install and sign in first.`);
}
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );

async function install(time) {
  if (process.platform !== "darwin")
    throw new Error("Scheduling uses launchd and requires macOS.");
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  if (!match) throw new Error("Give a time as HH:MM, for example 07:00.");
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  const log = join(await agentDir(piPackage()), "comms", "refresh.log");
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  // launchd starts with a bare PATH. Claude and Node must be found as now.
  const path = [
    ...new Set([dirname(which("claude")), dirname(process.execPath)]),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const days = [1, 2, 3, 4, 5]
    .map(
      (day) =>
        `<dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
    )
    .join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(fileURLToPath(import.meta.url))}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StartCalendarInterval</key><array>${days}</array>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(`${plist}.tmp`, body, { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", `${plist}.tmp`], {
    stdio: "ignore",
  });
  renameSync(`${plist}.tmp`, plist);
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], {
      stdio: "ignore",
    });
  } catch {
    /* Not loaded yet. */
  }
  execFileSync("/bin/launchctl", ["bootstrap", domain, plist]);
  return `Comms refresh scheduled on weekdays at ${time}. Log: ${log}. Remove with: comms-refresh.mjs uninstall`;
}
function uninstall() {
  try {
    execFileSync(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid()}/${label}`],
      { stdio: "ignore" },
    );
  } catch {
    /* Already unloaded. */
  }
  rmSync(plist, { force: true });
  return "Comms refresh schedule removed.";
}
async function refresh() {
  const packageDir = piPackage();
  const require = createRequire(join(packageDir, "package.json"));
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: {
      "@earendil-works/pi-ai": join(
        dirname(packageDir),
        "pi-ai",
        "dist",
        "index.js",
      ),
      typebox: require.resolve("typebox"),
    },
  });
  const { refreshOnce } = await jiti.import(
    join(root, "extensions", "comms", "headless.ts"),
  );
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => controller.abort());
  return refreshOnce(await agentDir(packageDir), controller.signal);
}

const stamp = () => new Date().toISOString();
try {
  const [command, argument] = process.argv.slice(2);
  if (command === "install") console.log(await install(argument));
  else if (command === "uninstall") console.log(uninstall());
  else if (command === undefined) {
    const { line, complete } = await refresh();
    console.log(`${stamp()} ${line}`);
    if (!complete) process.exitCode = 2;
  } else
    throw new Error("Usage: comms-refresh.mjs [install HH:MM | uninstall]");
} catch (error) {
  console.error(
    `${stamp()} ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
