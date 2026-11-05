import { visibleWidth } from "@earendil-works/pi-tui";
import {
  findChar,
  wordMotion,
  wordKind,
  type Find,
  type Position,
  type Segment,
} from "./motions.js";

export type Operator = "c" | "d";
export type OperatorEdit = {
  from: number;
  to: number;
  text: string;
  cursor: Position;
  /** Vim cancelled the operator but kept the motion's cursor. */
  cancelled?: true;
};

// Return one replacement range. Endpoints are exclusive UTF-16 offsets, always
// on the editor's grapheme/paste-marker boundaries. Unsupported motions and
// failed counts cancel.
export function operatorEdit(
  lines: string[],
  segments: Segment[][],
  cursor: Position,
  operator: Operator,
  motion: string | Find,
  count = 1,
): OperatorEdit | undefined {
  const starts: number[] = [];
  let length = 0;
  for (const line of lines) {
    starts.push(length);
    length += line.length + 1;
  }
  const offset = (at: Position) => starts[at.line] + at.col;
  const span = (from: Position, to: Position): OperatorEdit => ({
    from: offset(from),
    to: offset(to),
    text: "",
    cursor: from,
  });
  const firstNonblank = (line: number) =>
    lines[line].match(/^[ \t]*/u)![0].length;
  const wholeLines = (
    first: number,
    last: number,
    keepColumn = false,
  ): OperatorEdit => {
    if (operator === "c") {
      const indent = lines[first].slice(0, firstNonblank(first));
      return {
        from: starts[first],
        to: starts[last] + lines[last].length,
        text: indent,
        cursor: { line: first, col: indent.length },
      };
    }
    const remaining = lines
      .map((text, index) => ({ text, index }))
      .filter(({ index }) => index < first || index > last);
    const line = Math.min(first, Math.max(0, remaining.length - 1));
    const target = remaining[line];
    const text = target?.text ?? "";
    const column = visibleWidth(lines[cursor.line].slice(0, cursor.col));
    const col = keepColumn
      ? ((target ? segments[target.index] : []).findLast(
          (item) => visibleWidth(text.slice(0, item.index)) <= column,
        )?.index ?? 0)
      : text.match(/^[ \t]*/u)![0].length;
    return {
      from: starts[first] - (last === lines.length - 1 && first > 0 ? 1 : 0),
      to:
        last < lines.length - 1
          ? starts[last + 1]
          : starts[last] + lines[last].length,
      text: "",
      cursor: { line, col },
    };
  };
  // Vim's exclusive-motion rules: an end in column zero moves back to the end
  // of the previous line, or makes the range linewise from inside the indent.
  // A deletion covering all nonblank text of several lines is linewise too.
  const exclusive = (from: Position, to: Position): OperatorEdit => {
    const indented = from.col <= firstNonblank(from.line);
    if (to.col === 0 && to.line > from.line) {
      if (indented) return wholeLines(from.line, to.line - 1);
      to = { line: to.line - 1, col: lines[to.line - 1].length };
    }
    if (
      operator === "d" &&
      to.line > from.line &&
      indented &&
      !lines[to.line].slice(to.col).trim()
    )
      return wholeLines(from.line, to.line, true);
    return span(from, to);
  };
  const lastLine = lines.length - 1;
  // Like j, a line count clamps to the prompt but fails on its last line.
  const countedLine =
    count > 1 && cursor.line === lastLine
      ? undefined
      : Math.min(lastLine, cursor.line + count - 1);
  const units = segments[cursor.line];
  if (typeof motion !== "string") {
    const col = findChar(units, cursor.col, motion, count);
    if (col === undefined) return undefined;
    // f/t include the target character. F/T stop before the cursor character.
    if (motion.motion === "F" || motion.motion === "T") {
      return span({ ...cursor, col }, cursor);
    }
    const unit = units.find((item) => item.index === col)!;
    return span(cursor, { ...cursor, col: col + unit.segment.length });
  }
  if (motion === operator) {
    if (countedLine === undefined) return undefined;
    return wholeLines(cursor.line, countedLine, true);
  }
  const line = lines[cursor.line];
  const current = units.findIndex((item) => item.index === cursor.col);
  if (motion === "0") return span({ ...cursor, col: 0 }, cursor);
  if (motion === "$") {
    if (countedLine === undefined) return undefined;
    const end = { line: countedLine, col: lines[countedLine].length };
    if (
      operator === "d" &&
      countedLine > cursor.line &&
      cursor.col <= firstNonblank(cursor.line)
    )
      return wholeLines(cursor.line, countedLine, true);
    return span(cursor, end);
  }
  // An empty range still lets c enter INSERT, as cl on an empty line does.
  if (motion === "l") {
    return span(cursor, {
      ...cursor,
      col: units[current + count]?.index ?? line.length,
    });
  }
  if (motion === "h") {
    const col = units[Math.max(0, current - count)]?.index ?? 0;
    return span({ ...cursor, col }, cursor);
  }
  if (motion === "w") {
    const kind = wordKind(units[current]?.segment ?? "");
    // cw on a word acts like ce, except that it ends with the current word.
    if (operator === "c" && kind !== "empty" && kind !== "space") {
      let end = cursor;
      if (wordKind(units[current + 1]?.segment ?? "") === kind)
        end = wordMotion(segments, cursor, "e");
      end = wordMotion(segments, end, "e", count - 1);
      const unit = segments[end.line].find((item) => item.index === end.col);
      return span(cursor, {
        ...end,
        col: end.col + (unit?.segment.length ?? 0),
      });
    }
    // Earlier words cross lines like w. The last word stops at its line end.
    const from = wordMotion(segments, cursor, "w", count - 1);
    const text = lines[from.line];
    if (!text.length) {
      const to = from.line < lastLine ? { line: from.line + 1, col: 0 } : from;
      return exclusive(cursor, to);
    }
    const items = segments[from.line];
    let next = items.findIndex((item) => item.index === from.col);
    const fromKind = wordKind(items[next].segment);
    if (fromKind !== "space") {
      while (next < items.length && wordKind(items[next].segment) === fromKind)
        next++;
    }
    while (next < items.length && wordKind(items[next].segment) === "space")
      next++;
    return exclusive(cursor, {
      line: from.line,
      col: items[next]?.index ?? text.length,
    });
  }
  if (motion !== "b" && motion !== "e") return undefined;
  const target = wordMotion(segments, cursor, motion, count);
  if (motion === "b") {
    if (offset(target) === offset(cursor)) return undefined;
    // Vim's b stops on an empty first line, then fails if words remain.
    const before = wordMotion(segments, cursor, "b", count - 1);
    if (!lines[0] && offset(before) === 0)
      return { ...span(target, target), cancelled: true };
    return exclusive(target, cursor);
  }
  const unit = segments[target.line].find((item) => item.index === target.col);
  const end = { ...target, col: target.col + (unit?.segment.length ?? 0) };
  // Vim promotes a multiline deletion covering all nonblank text to whole lines.
  if (
    operator === "d" &&
    target.line > cursor.line &&
    cursor.col <= firstNonblank(cursor.line) &&
    !lines[target.line].slice(end.col).trim()
  )
    return wholeLines(cursor.line, target.line, true);
  return span(cursor, end);
}
