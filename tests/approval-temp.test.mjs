import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const packageDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(
  packageDir,
  "Run through node scripts/test.mjs or set PI_TEST_PACKAGE_DIR.",
);
const { createJiti } = createRequire(join(packageDir, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { ownedTempCleanup } = await jiti.import(
  new URL("../extensions/approval/temp-cleanup.ts", import.meta.url).pathname,
);

const allocation = "bundle=$(mktemp /tmp/approval-test.XXXXXX.bundle)";
const cleanup = 'rm -f -- "$bundle"';
const trap = `trap '${cleanup}' EXIT`;
const shell = [
  "set -euo pipefail",
  "cd /fixture/project",
  allocation,
  trap,
  'git bundle create "$bundle" HEAD',
  'cat "$bundle"',
  'wc -c < "$bundle"',
  "printf '%s' payload > \"$bundle\"",
  'cat "$bundle" | wc -c',
  "",
].join("\n");

function nodeHeredoc(script = shell) {
  return [
    "node <<'NODE'",
    "const { execFileSync } = require('node:child_process');",
    "const script = `",
    script,
    "`;",
    "const output = execFileSync('bash', ['-lc', script], { encoding: 'utf8' });",
    "process.stdout.write(output);",
    "NODE",
    "",
  ].join("\n");
}

function unchanged(source) {
  assert.deepEqual(ownedTempCleanup(source), { source, count: 0 });
}

for (const [name, source] of [
  ["direct shell with later reads, writes and use", shell],
  ["Node-heredoc-shaped bundle script", nodeHeredoc()],
  [
    "Node module with a double-quoted heredoc delimiter",
    nodeHeredoc()
      .replace("node <<'NODE'", 'node --input-type=module <<"NODE"')
      .replace(
        "const { execFileSync } = require('node:child_process');",
        "import { execFileSync } from 'node:child_process';",
      ),
  ],
  [
    "Node direct invocation",
    nodeHeredoc()
      .replace("const output = ", "")
      .replace("{ encoding: 'utf8' }", "{ stdio: 'inherit' }")
      .replace("process.stdout.write(output);\n", ""),
  ],
  [
    "Node invocation without options",
    nodeHeredoc().replace(", { encoding: 'utf8' }", ""),
  ],
  [
    "direct printf with a newline format",
    `${shell}printf '%s\\n' \"$bundle\"\n`,
  ],
  ["direct shell CRLF", shell.replaceAll("\n", "\r\n")],
  ["Node heredoc CRLF", nodeHeredoc().replaceAll("\n", "\r\n")],
  [
    "comments and indentation",
    shell
      .replace(allocation, `# create a file\n  ${allocation}`)
      .replace(trap, `\t${trap}  `),
  ],
]) {
  test(`suppresses only the owned trap: ${name}`, () => {
    const result = ownedTempCleanup(source);
    assert.deepEqual(result, {
      source: source.replace(trap, "trap ':' EXIT"),
      count: 1,
    });
    assert.equal(source.includes(trap), true, "input stays intact");
    assert.deepEqual(ownedTempCleanup(source), result, "deterministic");
    unchanged(result.source);
  });
}

for (const operation of [
  'rm -f -- "$bundle"',
  'rm -rf -- "$HOME/important"',
  'rm -r -- "$bundle"',
  "git reset --hard HEAD~1",
  "git push --force origin main",
  "sudo chmod 777 /important",
  "curl -X DELETE https://example.invalid/data",
]) {
  for (const wrap of [(source) => source, nodeHeredoc]) {
    test(`retains independent operation ${operation} (${wrap === nodeHeredoc ? "Node" : "shell"})`, () => {
      const source = wrap(`${shell}${operation}\n`);
      const result = ownedTempCleanup(source);
      assert.ok(result.count === 0 || result.count === 1);
      assert.ok(result.source.includes(operation));
    });
  }
}

const mutations = [
  'mv /important "$bundle"',
  'sudo mv /important "$bundle"',
  'ssh localhost mv /important "$bundle"',
  'kubectl exec pod -- mv /important "$bundle"',
  `git -c alias.move='!mv /important' move "$bundle"`,
  `printf '%s' "$bundle" | ssh localhost 'read f; mv /important "$f"'`,
  "bundle=/important",
  'bundle="$HOME/important"',
  "bundle+=/important",
  "bundle[0]=/important",
  allocation,
  "read -r bundle",
  'read -r "$name"',
  "mapfile bundle",
  "readarray bundle",
  "getopts x bundle",
  "eval 'bundle=/important'",
  'eval "$code"',
  ". ./settings.sh",
  "source ./settings.sh",
  "printf -v bundle '%s' /important",
  "printf '-v' bundle '%s' /important",
  'printf "$format" bundle /important',
  "printf -vbundle '%s' /important",
  "printf '%n' bundle",
  "printf '%5n' bundle",
  "printf '%s%n' data bundle",
  "printf '%*s' 'bundle=0' data",
  "test -v 'array[bundle=0]'",
  "command printf -v bundle '%s' /important",
  "builtin read bundle",
  "declare bundle=/important",
  "declare -n alias=bundle",
  "typeset bundle=/important",
  "local bundle=/important",
  "export bundle=/important",
  "readonly bundle=/important",
  "unset bundle",
  "let bundle=1",
  "((bundle=1))",
  ': "${bundle:=/important}"',
  ': "$((bundle=1))"',
  "echo \"$(eval 'bundle=/important')\"",
  "alias mktemp='printf /important'",
  "alias rm='rm -rf'",
  "enable -f ./custom.so rm",
  "hash -p /evil/mktemp mktemp",
  "mktemp() { printf '%s' /important; }",
  "function mktemp { printf '%s' /important; }",
  "rm() { command rm -rf /important; }",
  "function rm { command rm -rf /important; }",
];
for (const mutation of mutations) {
  test(`fails closed for state changes before and after the trap: ${mutation}`, () => {
    for (const source of [
      `${mutation}\n${shell}`,
      shell.replace(trap, `${mutation}\n${trap}`),
      `${shell}${mutation}\n`,
    ]) {
      unchanged(source);
      unchanged(nodeHeredoc(source));
    }
  });
}

for (const [name, source] of [
  ["unknown variable", trap],
  ["external variable", `git bundle create "$bundle" HEAD\n${trap}`],
  ["user path under tmp", `bundle=/tmp/important\n${trap}`],
  [
    "directory made by mkdir",
    `mkdir /tmp/example\nbundle=/tmp/example\n${trap}`,
  ],
  [
    "mktemp directory",
    shell.replace(
      allocation,
      "bundle=$(mktemp -d /tmp/approval-test.XXXXXX.bundle)",
    ),
  ],
  ["mktemp dry run", shell.replace("mktemp ", "mktemp -u ")],
  ["mkdir even after a file allocation", `${shell}mkdir \"$bundle\"\n`],
  [
    "non-shell whitespace before allocation",
    shell.replace(allocation, `\u00a0${allocation}`),
  ],
  [
    "non-shell whitespace before a rejected write",
    `${shell}\u00a0read bundle\n`,
  ],
  [
    "dynamic template",
    shell.replace("/tmp/approval-test.XXXXXX.bundle", '"$template"'),
  ],
  [
    "interpolated template",
    shell.replace("approval-test.XXXXXX", "$prefix.XXXXXX"),
  ],
  [
    "template from command substitution",
    shell.replace("approval-test.XXXXXX", "$(echo prefix).XXXXXX"),
  ],
  ["relative template", shell.replace("/tmp/approval-test", "approval-test")],
  [
    "user-supplied command output",
    shell.replace(
      "mktemp /tmp/approval-test.XXXXXX.bundle",
      "printf '%s' /important",
    ),
  ],
  ["unrecognized variable name", shell.replaceAll("bundle", "other")],
  ["recursive cleanup", shell.replace(cleanup, 'rm -r -- "$bundle"')],
  ["forced recursive cleanup", shell.replace(cleanup, 'rm -rf -- "$bundle"')],
  [
    "two cleanup targets",
    shell.replace(cleanup, 'rm -f -- "$bundle" /important'),
  ],
  [
    "two variable cleanup targets",
    shell.replace(cleanup, 'rm -f -- "$bundle" "$other"'),
  ],
  [
    "extra trap command",
    shell.replace(cleanup, `${cleanup}; rm -rf /important`),
  ],
  [
    "dynamic trap expansion",
    shell.replace(trap, 'trap "rm -f -- \\"$bundle\\"" EXIT'),
  ],
  ["unquoted cleanup target", shell.replace(cleanup, "rm -f -- $bundle")],
  [
    "expanded unquoted cleanup target",
    shell.replace(cleanup, 'rm -f -- "$bundle"*'),
  ],
  ["non-EXIT trap", shell.replace(" EXIT", " INT")],
  ["multiple trap signals", shell.replace(" EXIT", " EXIT INT")],
  ["trap before allocation", `${trap}\n${allocation}`],
  ["second trap", `${shell}${trap}`],
  [
    "conditional allocation",
    shell.replace(allocation, `if false; then\n${allocation}\nfi`),
  ],
  ["loop scope", `for bundle in /important; do\n${shell}done`],
  ["subshell allocation", shell.replace(allocation, `(${allocation})`)],
  ["function scope", `cleanup() {\n${shell}}`],
  [
    "allocation in a pipeline",
    shell.replace(allocation, `${allocation} | cat`),
  ],
  ["trap in a pipeline", shell.replace(trap, `${trap} | cat`)],
  ["separate shell strings", `sh -c '\n${allocation}\n'\nsh -c '\n${trap}\n'`],
  ["opaque command", `${shell}unknown_tool "$bundle"\n`],
  [
    "continuation",
    shell.replace(
      allocation,
      "bundle=$(mktemp \\\n/tmp/approval-test.XXXXXX.bundle)",
    ),
  ],
  ["unmatched quote", `echo '\n${shell}`],
  ["empty source", ""],
]) {
  test(`fails closed: ${name}`, () => {
    unchanged(source);
    unchanged(nodeHeredoc(source));
  });
}

for (const [name, source] of [
  ["unquoted Node heredoc", nodeHeredoc().replace("<<'NODE'", "<<NODE")],
  [
    "shell-expanded heredoc",
    nodeHeredoc()
      .replace("<<'NODE'", "<<EOF")
      .replace(/NODE\n$/, "EOF\n"),
  ],
  ["JS interpolation", nodeHeredoc(`${shell}echo \u0024{outside}\n`)],
  ["JS escape decoding", nodeHeredoc(shell.replace(trap, `${trap}\\n`))],
  [
    "two JS template scopes",
    nodeHeredoc().replace(
      "const script = `",
      "const first = `echo hi`;\nconst script = `",
    ),
  ],
  [
    "assignment and trap in separate templates",
    nodeHeredoc(`${allocation}\n\`;\nconst second = \`\n${trap}`),
  ],
  [
    "template in a JS block comment",
    nodeHeredoc()
      .replace("const script = `", "/*\nconst script = `")
      .replace("`;", "`;\n*/"),
  ],
  [
    "early heredoc terminator",
    nodeHeredoc().replace(
      "const script = `",
      "NODE\nnode <<'NODE'\nconst script = `",
    ),
  ],
  [
    "outer shell function override",
    `mktemp() { echo /important; }\n${nodeHeredoc()}`,
  ],
  [
    "mutable script binding",
    nodeHeredoc().replace("const script", "let script"),
  ],
  [
    "JS rewrites shell allocation",
    nodeHeredoc().replace(
      "'-lc', script]",
      "'-lc', script.replace(allocation, replacement)]",
    ),
  ],
  [
    "JS prepends shell code",
    nodeHeredoc().replace("'-lc', script]", "'-lc', prefix + script]"),
  ],
  [
    "JS appends shell code",
    nodeHeredoc().replace("'-lc', script]", "'-lc', script + suffix]"),
  ],
  [
    "custom execFileSync implementation",
    nodeHeredoc().replace(
      "const { execFileSync } = require('node:child_process');",
      "function execFileSync(shell, args) { run(prefix + args[1]); }",
    ),
  ],
  [
    "dynamic shell environment",
    nodeHeredoc().replace("{ encoding: 'utf8' }", "{ env: external }"),
  ],
  [
    "unrecognized JS operation",
    nodeHeredoc().replace("process.stdout.write(output);", "eval(external);"),
  ],
  [
    "delimiter with trailing spaces",
    nodeHeredoc().replace(/NODE\n$/, "NODE  \n"),
  ],
]) {
  test(`fails closed for wrapper ambiguity: ${name}`, () => unchanged(source));
}

test("does not execute the source or spawn a process", (t) => {
  const calls = [];
  for (const name of [
    "exec",
    "execFile",
    "execSync",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ]) {
    t.mock.method(childProcess, name, () => {
      calls.push(name);
      throw new Error("Source must never execute");
    });
  }
  const source = `${shell}touch /tmp/approval-temp-must-not-execute\n`;
  assert.equal(ownedTempCleanup(source).count, 1);
  assert.equal(ownedTempCleanup(nodeHeredoc(source)).count, 1);
  unchanged("eval 'touch /tmp/approval-temp-must-not-execute'");
  assert.deepEqual(calls, []);
});
