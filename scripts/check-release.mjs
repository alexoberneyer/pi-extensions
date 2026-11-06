import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = new Set([
  "agents",
  "bin",
  "docs",
  "examples",
  "extensions",
  "helpers",
  "lib",
  "scripts",
  "tests",
  "workflows",
]);
const rootFiles = new Set([
  ".gitignore",
  ".prettierignore",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE.md",
  "package.json",
  "package-lock.json",
]);
const ignored = new Set([
  ".git",
  "node_modules",
  ".scratch",
  "__pycache__",
  ".cache",
]);
const problems = [];
const paths = [];
function walk(directory, prefix = "") {
  for (const name of readdirSync(directory)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (ignored.has(name)) continue;
    const stat = lstatSync(join(directory, name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      problems.push(`${path}: links and special files are not release assets`);
      continue;
    }
    if (!prefix && !(stat.isDirectory() ? directories : rootFiles).has(name)) {
      problems.push(`${path}: outside the public-file allowlist`);
      continue;
    }
    if (stat.isDirectory()) {
      walk(join(directory, name), path);
      continue;
    }
    if (stat.size > 2 * 1024 * 1024) {
      problems.push(`${path}: unexpectedly large file`);
      continue;
    }
    if (
      !new Set([".ts", ".mjs", ".md", ".json", ".py", ".tape"]).has(
        extname(name),
      ) &&
      !["LICENSE", ".gitignore", ".prettierignore", ".npmignore"].includes(name)
    ) {
      problems.push(`${path}: unexpected file type`);
      continue;
    }
    if (
      /^(?:auth|mcp(?:-auth)?|credentials|config)\.json$|\.local\.json$|^\.env(?:\.|$)/i.test(
        name,
      )
    )
      problems.push(`${path}: private configuration filename`);
    const text = readFileSync(join(directory, name), "utf8");
    if (text.includes("\0")) problems.push(`${path}: binary content`);
    if (extname(name) === ".md" && /\u2014|\u2013|&mdash;|&ndash;/.test(text))
      problems.push(`${path}: forbidden dash punctuation`);
    paths.push(path);
  }
}
walk(root);
const privacy = spawnSync(
  "python3",
  ["scripts/public_repo_guard.py", "worktree"],
  { cwd: root, encoding: "utf8", timeout: 60_000 },
);
if (privacy.status !== 0)
  problems.push(privacy.stderr?.trim() || "Disclosure guard failed to run");
else if (privacy.stderr) console.error(privacy.stderr.trim());
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const entry of manifest.pi?.extensions || [])
  if (!paths.includes(entry.replace(/^\.\//, "")))
    problems.push(`${entry}: missing declared extension`);
if (!manifest.license || !paths.includes("LICENSE"))
  problems.push("Explicit package license and LICENSE are required");

const scratch = mkdtempSync(join(tmpdir(), "pi-release-"));
let packageFiles = [];
try {
  const result = spawnSync(
    "npm",
    ["pack", "--offline", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: scratch,
        npm_config_cache: join(scratch, "npm-cache"),
        npm_config_userconfig: "/dev/null",
      },
    },
  );
  if (result.status !== 0)
    problems.push("Script-free npm package dry run failed");
  else {
    packageFiles = JSON.parse(result.stdout)[0].files.map((file) => file.path);
    for (const path of packageFiles) {
      if (
        !paths.includes(path) ||
        /(?:^|\/)(?:node_modules|__pycache__|\.cache|\.scratch)(?:\/|$)|\.pyc$|^helpers\/test_/.test(
          path,
        )
      )
        problems.push(`${path}: unintended package asset`);
    }
    for (const required of [
      ...manifest.pi.extensions.map((entry) => entry.replace(/^\.\//, "")),
      "lib/config.mjs",
      "bin/dev01-status.py",
      "helpers/reminders.py",
      "workflows/comms/triage.md",
      "LICENSE",
    ])
      if (!packageFiles.includes(required))
        problems.push(`${required}: omitted from package`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else
  console.log(
    `Release checks passed: ${paths.length} public source files, ${packageFiles.length} package files. No publishing performed.`,
  );
