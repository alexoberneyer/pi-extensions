import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.argv[2] === "--python";
let host = process.env.PI_TEST_PACKAGE_DIR;
if (!python && !host) {
  const managed =
    process.env.PI_MANAGED_INSTALL_ROOT ||
    join(homedir(), ".pi", "agent", "install");
  const versionFile = join(managed, "current-version");
  if (existsSync(versionFile)) {
    const version = readFileSync(versionFile, "utf8").trim();
    if (!/^[\w.-]+$/.test(version))
      throw new Error("Invalid managed Pi version.");
    host = join(
      managed,
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
  } else {
    const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (result.status !== 0)
      throw new Error("Set PI_TEST_PACKAGE_DIR to the installed Pi package.");
    host = join(result.stdout.trim(), "@earendil-works", "pi-coding-agent");
  }
}
if (!python && !existsSync(join(host, "dist", "index.js")))
  throw new Error(
    "PI_TEST_PACKAGE_DIR does not contain an installed Pi package.",
  );
// Short paths leave room for macOS Unix-domain sockets used by fixture tmux.
const scratch = mkdtempSync(
  join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pie-"),
);
try {
  const home = join(scratch, "home");
  const temp = join(scratch, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o700 });
  const config = join(home, "config.json");
  writeFileSync(config, "{}\n", { mode: 0o600 });
  const files = process.argv.slice(2);
  const selected = files.length
    ? files
    : readdirSync(join(root, "tests"))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => join("tests", name));
  const command = python
    ? process.env.PI_TEST_PYTHON || "python3"
    : process.execPath;
  const args = python
    ? ["-m", "unittest", "discover", "-s", "helpers", "-p", "test_*.py"]
    : ["--test", "--test-reporter=tap", "--test-concurrency=1", ...selected];
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    timeout: 600_000,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_TEST_PACKAGE_DIR: host || "",
      PI_PARITY_PACKAGE_DIR: host || "",
      PI_EXTENSIONS_CONFIG: config,
      PI_AGENTS_EXTERNAL: "0",
      PI_AGENTS_DEV01: "0",
      PI_QMD_REFRESH: "0",
      PI_NOTIFY: "0",
      PYTHONDONTWRITEBYTECODE: "1",
      UV_OFFLINE: "1",
      UV_NO_CONFIG: "1",
      UV_CACHE_DIR: join(scratch, "uv-cache"),
      CI: "1",
      NO_COLOR: "1",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
