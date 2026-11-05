import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { editorPort, prioritizeInput } from "./editor-port.js";
import {
  FIND_MOTIONS,
  findChar,
  repeatFind,
  wordMotion,
  type Find,
  type Position,
} from "./motions.js";
import { operatorEdit, type Operator } from "./operators.js";

const PASTE_START = "\x1b[200~";
// A count, an operator, a second count and a pending f/F/t/T, as in 2d3t.
const PENDING = /^(\d*)([cd]?)(\d*)([fFtT]?)$/;

function parsePending(pending: string) {
  const [, before, operator, after, search] = PENDING.exec(pending)!;
  return {
    // Vim multiplies the counts around an operator: 2d3w deletes six words.
    count: Number(before || 1) * Number(after || 1),
    operator: (operator || undefined) as Operator | undefined,
    search: (search || undefined) as Find["motion"] | undefined,
  };
}
const PASTE_END = "\x1b[201~";

function normalKey(data: string): string | undefined {
  // Use the actual text, not parseKey's physical/base-layout key identity.
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) {
    const codepoint = kitty.codePointAt(0)!;
    // Kitty reserves this range for functional keys, including keypad Enter.
    return codepoint === 127 || (codepoint >= 0xe000 && codepoint <= 0xf8ff)
      ? undefined
      : kitty;
  }
  // Pi does not publicly export its modifyOtherKeys printable decoder.
  const modified = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (modified) {
    const modifiers = (Number(modified[1]) - 1) & ~0xc0; // Ignore Caps/Num Lock.
    const codepoint = Number(modified[2]);
    if (
      (modifiers === 0 || modifiers === 1) &&
      codepoint >= 32 &&
      codepoint !== 127 &&
      codepoint <= 0x10ffff
    )
      return String.fromCodePoint(codepoint);
    return undefined; // Ctrl/Alt shortcuts stay with Pi.
  }
  return /^[^\x00-\x1f\x7f]+$/u.test(data) ? data : undefined;
}

export class VimEditor extends CustomEditor {
  /** An embedded editor leaves its view instead of interrupting the agent. */
  onNormalEscape?: () => void;
  private mode: "insert" | "normal" = "insert";
  private port: ReturnType<typeof editorPort>;
  private bindings: KeybindingsManager;
  private pasting = false;
  private verticalColumn: number | undefined;
  /** Typed command prefix, such as 2, d, f or 2d3t. */
  private pending: string | undefined;
  private lastFind: Find | undefined;
  private changeDepth: number | undefined;
  private viewportActions: string[];

  constructor(tui: TUI, theme: EditorTheme, bindings: KeybindingsManager) {
    super(tui, theme, bindings, { embedWorkingStatus: true });
    this.bindings = bindings;
    this.port = editorPort(this);
    this.viewportActions = Object.keys(bindings.getResolvedBindings()).filter(
      (action) => action.startsWith("tui.altScreen."),
    );
  }

  get supported(): boolean {
    return this.port !== undefined;
  }

  readonly inputListener = (data: string) => {
    this.observeInput(data);
    return undefined;
  };

  private observeInput(data: string): void {
    if (!this.pending || this.pasting || isKeyRelease(data)) return;
    const viewportKey = this.viewportActions.some((action) =>
      this.bindings.matches(
        data,
        action as Parameters<KeybindingsManager["matches"]>[1],
      ),
    );
    if (
      !this.focused ||
      (!matchesKey(data, "escape") &&
        (viewportKey || normalKey(data) === undefined))
    ) {
      this.pending = undefined;
      this.tui.requestRender();
    }
  }

  private segments(line = this.getCursor().line) {
    return this.port!.segments(this.getLines()[line]);
  }

  private move(position: Position) {
    this.port!.move(position);
  }

  private clampNormalCursor() {
    if (this.mode !== "normal" || this.isShowingAutocomplete()) return;
    const cursor = this.getCursor();
    const col =
      this.segments().findLast((item) => item.index <= cursor.col)?.index ?? 0;
    if (col !== cursor.col) this.move({ ...cursor, col });
  }

  private collapseChange() {
    if (this.changeDepth === undefined || !this.port) return;
    if (this.port.undoDepth() <= this.changeDepth) this.changeDepth = undefined;
    else this.port.collapseUndo(this.changeDepth);
  }

  private finishChange() {
    this.collapseChange();
    this.changeDepth = undefined;
  }

  private applyOperator(operator: Operator, motion: string | Find, count = 1) {
    const lines = this.getLines();
    const edit = operatorEdit(
      lines,
      lines.map((line) => this.port!.segments(line)),
      this.getCursor(),
      operator,
      motion,
      count,
    );
    if (edit?.cancelled) this.move(edit.cursor);
    if (!edit || edit.cancelled || (operator === "d" && edit.from === edit.to))
      return;
    const depth = this.port!.undoDepth();
    this.port!.replace(edit);
    this.verticalColumn = undefined;
    if (operator === "c") {
      this.mode = "insert";
      this.changeDepth = depth;
    } else this.clampNormalCursor();
  }

  private passInput(data: string) {
    const hadText = this.getText().length > 0;
    const submitting =
      !this.disableSubmit && this.bindings.matches(data, "tui.input.submit");
    super.handleInput(data);
    this.collapseChange();
    if (!this.getText() && (hadText || submitting)) this.mode = "insert";
    this.verticalColumn = undefined;
    this.clampNormalCursor();
  }

  override setText(text: string): void {
    this.finishChange();
    this.port?.clearRedo();
    this.pending = undefined;
    super.setText(text);
    this.mode = "insert";
    this.verticalColumn = undefined;
  }

  override handleInput(data: string): void {
    if (!this.port) {
      super.handleInput(data);
      return;
    }
    this.collapseChange();
    // Pi owns the entire paste, including chunks that look like Vim commands.
    if (this.pasting || data.includes(PASTE_START)) {
      this.pending = undefined;
      this.pasting = !data.includes(PASTE_END);
      this.passInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.port.cancelJump();
      this.verticalColumn = undefined;
      if (this.pending) {
        this.pending = undefined;
      } else if (this.isShowingAutocomplete()) {
        this.port.closeAutocomplete();
      } else if (this.mode === "insert") {
        this.finishChange();
        this.mode = "normal";
        const cursor = this.getCursor();
        const col =
          this.segments().findLast((item) => item.index < cursor.col)?.index ??
          0;
        this.move({ ...cursor, col });
      } else if (this.onNormalEscape) {
        this.onNormalEscape();
      } else {
        // Pi keeps its normal interrupt and empty-prompt double-Escape behavior.
        super.handleInput(data);
      }
      return;
    }
    if (this.mode === "normal" && matchesKey(data, "ctrl+r")) {
      // A bare count repeats redo. A pending operator or search is cancelled.
      const pending = parsePending(this.pending ?? "");
      const count = pending.operator || pending.search ? 1 : pending.count;
      this.pending = undefined;
      this.port.cancelJump();
      for (let i = 0; i < count && this.port.redo(); i++);
      this.verticalColumn = undefined;
      this.clampNormalCursor();
      this.tui.requestRender();
      return;
    }
    if (this.mode === "insert" || this.port.jumpPending()) {
      this.pending = undefined;
      this.passInput(data);
      return;
    }

    const key = normalKey(data);
    if (key === undefined) {
      this.pending = undefined;
      this.passInput(data);
      return;
    }
    // A picker may have been opened with Tab while in Normal mode.
    this.port.closeAutocomplete();
    this.clampNormalCursor();
    const count = this.prefixed(key);
    if (count === undefined) {
      this.tui.requestRender();
      return;
    }
    const cursor = this.getCursor();
    const segments = this.segments();
    const current = segments.findIndex((item) => item.index === cursor.col);
    const last = segments.at(-1)?.index ?? 0;
    if (key === "j" || key === "k") {
      const line = Math.max(
        0,
        Math.min(
          this.getLines().length - 1,
          cursor.line + (key === "j" ? count : -count),
        ),
      );
      if (line === cursor.line) return;
      this.verticalColumn ??= visibleWidth(
        this.getLines()[cursor.line].slice(0, cursor.col),
      );
      const text = this.getLines()[line];
      const col =
        this.segments(line).findLast(
          (item) =>
            visibleWidth(text.slice(0, item.index)) <= this.verticalColumn!,
        )?.index ?? 0;
      this.move({ line, col });
      return;
    }
    this.verticalColumn = undefined;
    // Counts on i, a, I and A are ignored instead of repeating the insert.
    switch (key) {
      case "i":
        this.mode = "insert";
        break;
      case "a":
        this.move({
          ...cursor,
          col: segments[current]
            ? cursor.col + segments[current].segment.length
            : 0,
        });
        this.mode = "insert";
        break;
      case "I":
        this.move({
          ...cursor,
          col:
            segments.find((item) => !/^\s+$/u.test(item.segment))?.index ??
            last,
        });
        this.mode = "insert";
        break;
      case "A":
        this.move({ ...cursor, col: this.getLines()[cursor.line].length });
        this.mode = "insert";
        break;
      case "h":
        this.move({
          ...cursor,
          col: segments[Math.max(0, current - count)]?.index ?? 0,
        });
        break;
      case "l":
        this.move({
          ...cursor,
          col:
            segments[Math.min(current + count, segments.length - 1)]?.index ??
            last,
        });
        break;
      case "0":
        this.move({ ...cursor, col: 0 });
        break;
      case "$": {
        // Like j, a count clamps to the prompt but fails on its last line.
        const lines = this.getLines();
        if (count > 1 && cursor.line === lines.length - 1) break;
        const line = Math.min(lines.length - 1, cursor.line + count - 1);
        this.move({ line, col: this.segments(line).at(-1)?.index ?? 0 });
        this.verticalColumn = Infinity;
        break;
      }
      case "w":
      case "b":
      case "e":
        this.move(
          wordMotion(
            this.getLines().map((line) => this.port!.segments(line)),
            cursor,
            key,
            count,
          ),
        );
        break;
      case "C":
      case "D":
        this.applyOperator(key === "C" ? "c" : "d", "$", count);
        break;
      case "x":
        if (count > 1) this.applyOperator("d", "l", count);
        else if (segments.length) this.port.deleteCharacter();
        this.clampNormalCursor();
        break;
      case "u":
        for (let i = 0; i < count && this.port.undoDepth(); i++)
          this.port.undo();
        this.clampNormalCursor();
        break;
      // Unsupported printable keys are inert, not accidental prompt text.
    }
    this.tui.requestRender();
  }

  // Counts and c/d wait for a motion. f/F/t/T wait for a character. Returns
  // the count for an ordinary NORMAL key, or undefined once the key is used.
  private prefixed(key: string): number | undefined {
    const pending = this.pending ?? "";
    this.pending = undefined;
    const { count, operator, search } = parsePending(pending);
    if (search) {
      // Any printable key is the target, including c, d, f or ;.
      this.lastFind = { motion: search, char: key };
      this.find(operator, this.lastFind, count);
    } else if (
      /^[1-9]$/.test(key) ||
      (key === "0" && /\d$/.test(pending)) ||
      (!operator && (key === "c" || key === "d")) ||
      FIND_MOTIONS.includes(key)
    ) {
      // Pi rebinds registered listeners on renderer switches. Re-establish
      // priority here, after listener dispatch, before arming a new prefix.
      if (prioritizeInput(this.tui, this.inputListener)) {
        this.pending = pending + key;
        this.verticalColumn = undefined;
      }
    } else if (key === ";" || key === ",") {
      this.find(operator, repeatFind(this.lastFind, key), count);
    } else if (operator) {
      this.applyOperator(operator, key, count);
    } else return count;
    return undefined;
  }

  private find(
    operator: Operator | undefined,
    find: Find | undefined,
    count: number,
  ) {
    this.verticalColumn = undefined;
    if (!find) return;
    if (operator) {
      this.applyOperator(operator, find, count);
      return;
    }
    const cursor = this.getCursor();
    const col = findChar(this.segments(), cursor.col, find, count);
    if (col !== undefined) this.move({ ...cursor, col });
  }

  override handleMouse(event: TuiMouseEvent) {
    this.pending = undefined;
    const result = super.handleMouse(event);
    this.verticalColumn = undefined;
    if (this.port) this.clampNormalCursor();
    return result;
  }

  protected override renderBottomBorder(
    width: number,
    hiddenLines: number,
  ): string {
    const border = super.renderBottomBorder(width, hiddenLines);
    const label = ` ${this.pending ? `${this.pending} · ` : ""}${this.mode.toUpperCase()} `;
    if (!this.port || width < label.length + 2) return border;
    return (
      truncateToWidth(border, width - label.length, "") +
      this.borderColor(label)
    );
  }
}

export function createVimEditor(
  tui: TUI,
  theme: EditorTheme,
  bindings: KeybindingsManager,
  onTerminalInput: ExtensionUIContext["onTerminalInput"] | undefined,
  onNormalEscape?: () => void,
): { editor: CustomEditor; vimEnabled: boolean; dispose: () => void } {
  const editor = new VimEditor(tui, theme, bindings);
  editor.onNormalEscape = onNormalEscape;
  let stopInput: (() => void) | undefined;
  const dispose = () => {
    editor.focused = false;
    stopInput?.();
    stopInput = undefined;
  };
  if (editor.supported && onTerminalInput) {
    stopInput = onTerminalInput(editor.inputListener);
    if (prioritizeInput(tui, editor.inputListener))
      return { editor, vimEnabled: true, dispose };
  }
  dispose();
  return {
    editor: new CustomEditor(tui, theme, bindings, {
      embedWorkingStatus: true,
    }),
    vimEnabled: false,
    dispose,
  };
}

export default function (pi: ExtensionAPI) {
  let factory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
  let stopInput: (() => void) | undefined;
  pi.on("session_shutdown", () => {
    stopInput?.();
    stopInput = undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    stopInput?.();
    stopInput = undefined;
    if (ctx.mode !== "tui") return;
    const existing = ctx.ui.getEditorComponent();
    if (existing && existing !== factory) {
      ctx.ui.notify(
        "Vim mode was not enabled: another extension owns the prompt editor.",
        "warning",
      );
      return;
    }
    factory = (tui, theme, bindings) => {
      stopInput?.();
      stopInput = undefined;
      const created = createVimEditor(tui, theme, bindings, (listener) =>
        ctx.ui.onTerminalInput(listener),
      );
      stopInput = created.dispose;
      if (!created.vimEnabled)
        ctx.ui.notify(
          "This Pi editor version is unsupported. Vim mode is off; normal Pi editing still works.",
          "warning",
        );
      return created.editor;
    };
    ctx.ui.setEditorComponent(factory);
  });
}
