// Deliberately small: straight-line commands, not a shell parser or security boundary.
const commands = new Set(
  "cat cd cp echo false head ls printf sha256sum shasum sleep tail touch true wc :".split(
    " ",
  ),
);
const allocation =
  /^bundle=\$\(mktemp \/tmp\/[A-Za-z0-9._-]*X{6}[A-Za-z0-9._-]*\)$/;
const cleanup = 'rm -f -- "$bundle"';
const trap = `trap '${cleanup}' EXIT`;

function simpleCommand(words: string[]): boolean {
  const bundleCommand =
    words[0] === "git" &&
    words[1] === "bundle" &&
    ["create", "verify", "list-heads"].includes(words[2]);
  if (!commands.has(words[0]) && !bundleCommand) return false;
  // Shell printf can write variables with -v, %n and arithmetic field widths.
  // Admit only the ordinary literal string format (optionally followed by \\n).
  if (words[0] === "printf" && !/^(['"])%s(?:\\n)?\1$/.test(words[1] ?? ""))
    return false;
  for (let i = 1; i < words.length; i++) {
    if (/^[<>]/.test(words[i])) {
      if (!words[i + 1] || /^[<>|]/.test(words[++i])) return false;
    }
  }
  return true;
}

function simpleLine(line: string): boolean {
  if (!line || line.startsWith("#")) return true;
  if (/^set -(?:e|eu|euo pipefail)$/.test(line)) return true;
  // No substitutions, escapes, compound commands, indirect writes or dynamic names.
  // Quoted arguments remain data. Only simple $name expansions are recognized.
  const token =
    /[ \t]+|(?:[A-Za-z0-9_./:@%+,=*?~-]+|\$[A-Za-z_][A-Za-z0-9_]*|'[^'\r\n]*'|"(?:[^"$`\\\r\n]|\$[A-Za-z_][A-Za-z0-9_]*)*")+|>>?|<|\|/y;
  let offset = 0;
  let words: string[] = [];
  while (offset < line.length) {
    token.lastIndex = offset;
    const match = token.exec(line);
    if (!match) return false;
    offset = token.lastIndex;
    const word = match[0];
    if (/^[ \t]+$/.test(word)) continue;
    if (word === "|") {
      if (!simpleCommand(words)) return false;
      words = [];
    } else words.push(word);
  }
  return simpleCommand(words);
}

function shellCleanup(source: string): { source: string; count: number } {
  const lines = source.split("\n");
  let created = -1;
  let cleaned = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").replace(/^[ \t]+|[ \t]+$/g, "");
    if (allocation.test(line)) {
      if (created !== -1) return { source, count: 0 };
      created = i;
    } else if (line === trap) {
      if (cleaned !== -1) return { source, count: 0 };
      cleaned = i;
    } else if (!simpleLine(line)) return { source, count: 0 };
  }
  if (created === -1 || cleaned <= created) return { source, count: 0 };
  lines[cleaned] = lines[cleaned].replace(cleanup, ":");
  return { source: lines.join("\n"), count: 1 };
}

/**
 * Return a RISK-ANALYSIS-ONLY copy. NEVER execute the returned source.
 * Recognizes only bundle=$(mktemp /tmp/<literal template>) and its exact single-file
 * EXIT trap in one straight-line scope. Unrecognized syntax leaves the source intact.
 * Also admits a quoted Node heredoc with a native execFileSync import, one literal
 * const script, and a direct bash/sh invocation. No other JS statements are admitted
 * except capturing and writing its output. No escapes or interpolation in the template.
 * This proves only the local idiom, not the execution environment or filesystem.
 */
export function ownedTempCleanup(source: string): {
  source: string;
  count: number;
} {
  const direct = shellCleanup(source);
  if (direct.count) return direct;

  const doc =
    /^[ \t]*(?:node|nodejs)(?:[ \t]+--input-type=(?:module|commonjs))?[ \t]+<<[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\r?\n([\s\S]*)\r?\n\2(?:\r?\n)?$/.exec(
      source,
    );
  if (!doc) return direct;
  const body = doc[3];
  // An earlier delimiter would end the heredoc. Do not merge separate scopes.
  if (body.split("\n").some((line) => line.replace(/\r$/, "") === doc[2]))
    return direct;
  const parts = body.split("`");
  if (parts.length !== 3 || /\\|\$\{/.test(parts[1])) return direct;
  // Recognize the wrapper, rather than trusting an arbitrary JS transformation or scope.
  const before =
    /^\s*(?:const\s*\{\s*execFileSync\s*\}\s*=\s*require\(\s*(['"])(?:node:)?child_process\1\s*\)|import\s*\{\s*execFileSync\s*\}\s*from\s*(['"])(?:node:)?child_process\2)\s*;\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(
      parts[0],
    );
  if (!before) return direct;
  const after = new RegExp(
    String.raw`^;\s*(?:const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?execFileSync\(\s*(['"])(?:/bin/)?(?:bash|sh)\2\s*,\s*\[\s*(['"])-l?c\3\s*,\s*${before[3]}\s*\](?:\s*,\s*\{\s*(?:encoding\s*:\s*(['"])utf8\4|stdio\s*:\s*(['"])inherit\5)\s*\})?\s*\)\s*;\s*(?:process\.stdout\.write\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;\s*)?$`,
  ).exec(parts[2]);
  if (!after || (after[6] && after[6] !== after[1])) return direct;
  const inner = shellCleanup(parts[1]);
  if (!inner.count) return direct;
  const start = source.indexOf("\n") + 1 + parts[0].length + 1;
  return {
    source:
      source.slice(0, start) +
      inner.source +
      source.slice(start + parts[1].length),
    count: inner.count,
  };
}
