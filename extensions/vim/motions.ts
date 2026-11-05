export type Position = { line: number; col: number };
export type Segment = { segment: string; index: number };
export type Find = {
  motion: "f" | "F" | "t" | "T";
  char: string;
  /** A ; or , repeat, which moves past a match right next to the cursor. */
  repeat?: boolean;
};
type Token = Position & { kind: string };

export const FIND_MOTIONS: readonly string[] = ["f", "F", "t", "T"];
const REVERSE = { f: "F", F: "f", t: "T", T: "t" } as const;

// ; repeats the last f/F/t/T and , repeats it in the other direction.
export function repeatFind(
  last: Find | undefined,
  key: string,
): Find | undefined {
  if (!last) return undefined;
  const motion = key === "," ? REVERSE[last.motion] : last.motion;
  return { motion, char: last.char, repeat: true };
}

// Vim's f/F/t/T stay on the line and step over whole characters. A character
// matches when it starts with the typed one, so "e" finds a decomposed "é".
// Returns the column for the count-th match, or undefined when there is none.
export function findChar(
  segments: Segment[],
  col: number,
  find: Find,
  count = 1,
): number | undefined {
  const forward = find.motion === "f" || find.motion === "t";
  const till = find.motion === "t" || find.motion === "T";
  const step = forward ? 1 : -1;
  const start = segments.findIndex((item) => item.index === col);
  if (start < 0) return undefined;
  // Neovim's default 'cpoptions' lets a repeated t/T move past an adjacent
  // match. Like Vim, it only does so without a count.
  let skip = find.repeat && till && count === 1;
  let remaining = count;
  for (let i = start + step; i >= 0 && i < segments.length; i += step) {
    const match = !skip && segments[i].segment.startsWith(find.char);
    if (match && --remaining === 0) return segments[till ? i - step : i].index;
    skip = false;
  }
  return undefined;
}

export function wordKind(text: string): string {
  if (text === "") return "empty";
  if (/^\s+$/u.test(text)) return "space";
  if (/^\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/.test(text)) {
    return "paste";
  }
  // Match common clean-Vim Unicode class boundaries, not just letter/number.
  const codepoint = text.codePointAt(0)!;
  if (codepoint < 256) {
    return /^[\p{L}\p{M}0-9_]/u.test(text) || codepoint >= 192
      ? "word"
      : "punctuation";
  }
  if (codepoint >= 0x2070 && codepoint <= 0x207f) return "superscript";
  if (codepoint >= 0x2080 && codepoint <= 0x209f) return "subscript";
  if (/^\p{Script=Han}/u.test(text)) return "han";
  if (/^\p{Script=Hiragana}/u.test(text)) return "hiragana";
  if (/^\p{Script=Katakana}/u.test(text)) return "katakana";
  if (/^\p{Script=Hangul}/u.test(text)) return "hangul";
  if (/^\p{Extended_Pictographic}/u.test(text)) return "emoji";
  return /^[\p{L}\p{N}\p{M}_]/u.test(text) ? "word" : "punctuation";
}

// Unlike Pi's word navigation, Vim treats punctuation as a separate word.
// Empty lines are stops for w/b. Newlines between nonempty lines are whitespace.
export function wordMotion(
  lines: Segment[][],
  cursor: Position,
  motion: "w" | "b" | "e",
  count = 1,
): Position {
  const tokens: Token[] = [];
  for (const [line, segments] of lines.entries()) {
    for (const item of segments.length
      ? segments
      : [{ segment: "", index: 0 }]) {
      tokens.push({ line, col: item.index, kind: wordKind(item.segment) });
    }
    if (line < lines.length - 1) {
      const last = segments.at(-1);
      tokens.push({
        line,
        col: last ? last.index + last.segment.length : 0,
        kind: "space",
      });
    }
  }
  let index = tokens.findIndex(
    (token) => token.line === cursor.line && token.col === cursor.col,
  );
  if (index < 0) return cursor;
  const last = tokens.length - 1;
  // Stop early at either end of the prompt, so a huge count stays cheap.
  for (let step = 0, before = -1; step < count && index !== before; step++) {
    before = index;
    if (motion === "w") {
      const current = tokens[index].kind;
      if (current !== "space") {
        while (index < last && tokens[index].kind === current) index++;
      }
      while (index < last && tokens[index].kind === "space") index++;
    } else if (motion === "b") {
      index = Math.max(0, index - 1);
      while (index > 0 && tokens[index].kind === "space") index--;
      while (index > 0 && tokens[index - 1].kind === tokens[index].kind)
        index--;
    } else {
      index = Math.min(last, index + 1);
      while (index < last && ["space", "empty"].includes(tokens[index].kind))
        index++;
      while (index < last && tokens[index + 1].kind === tokens[index].kind)
        index++;
    }
  }
  const { line, col } = tokens[index];
  return { line, col };
}
