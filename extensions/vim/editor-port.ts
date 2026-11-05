import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Position, Segment } from "./motions.js";
import type { OperatorEdit } from "./operators.js";
import type { TUI } from "@earendil-works/pi-tui";

// Private integration boundaries stay here so upgrades have one place to check.
// Pi has no public cursor setter, direct editing actions or pre-viewport input.
type InputListener = Parameters<TUI["addInputListener"]>[0];

export function prioritizeInput(tui: TUI, listener: InputListener): boolean {
  const listeners = (tui as unknown as { inputListeners?: Set<InputListener> })
    .inputListeners;
  if (!(listeners instanceof Set) || !listeners.has(listener)) return false;
  const existing = [...listeners];
  listeners.clear();
  listeners.add(listener);
  for (const current of existing) listeners.add(current);
  return true;
}

type Internals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  lastAction: unknown;
  jumpMode: "forward" | "backward" | null;
  undoStack: { length: number; pop(): unknown; clear(): void };
  pastes: Map<number, string>;
  pasteCounter: number;
  onChange?: (text: string) => void;
  pushUndoSnapshot(): void;
  exitHistoryBrowsing(): void;
  setCursorCol(col: number): void;
  segment(text: string, granularity: "grapheme"): Iterable<Segment>;
  cancelAutocomplete(): void;
  handleForwardDelete(): void;
  undo(): void;
};

type Snapshot = Pick<Internals, "state" | "pastes" | "pasteCounter">;
const PORT = Symbol.for("dotfiles.pi.vim.editor-port.v1");

function createEditorPort(editor: CustomEditor) {
  const e = editor as unknown as Internals;
  if (
    !Array.isArray(e.state?.lines) ||
    typeof e.state.cursorLine !== "number" ||
    typeof e.state.cursorCol !== "number" ||
    !("lastAction" in e) ||
    !("jumpMode" in e) ||
    typeof e.undoStack?.length !== "number" ||
    typeof e.undoStack.pop !== "function" ||
    typeof e.undoStack.clear !== "function" ||
    !(e.pastes instanceof Map) ||
    typeof e.pasteCounter !== "number" ||
    ![
      "setCursorCol",
      "segment",
      "cancelAutocomplete",
      "handleForwardDelete",
      "pushUndoSnapshot",
      "exitHistoryBrowsing",
      "undo",
    ].every((name) => typeof e[name as keyof Internals] === "function")
  ) {
    return undefined;
  }
  const redos: Snapshot[] = [];
  const clearRedo = () => {
    redos.length = 0;
  };
  const pushUndo = e.pushUndoSnapshot.bind(e);
  const undo = e.undo.bind(e);
  const clearUndo = e.undoStack.clear.bind(e.undoStack);
  // Track native undo too. Native edits and async completions go through
  // pushUndoSnapshot; submission clears the stack. Neither depends on keymaps.
  e.pushUndoSnapshot = () => {
    clearRedo();
    pushUndo();
  };
  e.undoStack.clear = () => {
    clearRedo();
    clearUndo();
  };
  e.undo = () => {
    if (!e.undoStack.length) return;
    redos.push(
      structuredClone({
        state: e.state,
        pastes: e.pastes,
        pasteCounter: e.pasteCounter,
      }),
    );
    undo();
  };
  return {
    clearRedo,
    segments: (text: string) => [...e.segment(text, "grapheme")],
    undoDepth: () => e.undoStack.length,
    collapseUndo(depth: number) {
      while (e.undoStack.length > depth + 1) e.undoStack.pop();
    },
    replace(edit: OperatorEdit) {
      e.cancelAutocomplete();
      e.pushUndoSnapshot();
      e.exitHistoryBrowsing();
      e.lastAction = null;
      const text = editor.getText();
      e.state.lines = (
        text.slice(0, edit.from) +
        edit.text +
        text.slice(edit.to)
      ).split("\n");
      e.state.cursorLine = edit.cursor.line;
      e.setCursorCol(edit.cursor.col);
      e.onChange?.(editor.getText());
    },
    move({ line, col }: Position) {
      e.cancelAutocomplete();
      e.lastAction = null;
      e.state.cursorLine = line;
      e.setCursorCol(col);
    },
    closeAutocomplete: () => e.cancelAutocomplete(),
    jumpPending: () => e.jumpMode !== null,
    cancelJump: () => {
      e.jumpMode = null;
    },
    deleteCharacter() {
      e.handleForwardDelete();
      e.cancelAutocomplete();
    },
    undo() {
      e.cancelAutocomplete();
      e.undo();
    },
    redo(): boolean {
      const next = redos.pop();
      if (!next) return false;
      e.cancelAutocomplete();
      e.exitHistoryBrowsing();
      // A redo must add an undo point without discarding the remaining redos.
      pushUndo();
      Object.assign(e.state, next.state);
      e.pastes = next.pastes;
      e.pasteCounter = next.pasteCounter;
      e.lastAction = null;
      e.setCursorCol(next.state.cursorCol);
      e.onChange?.(editor.getText());
      return true;
    },
  };
}

export function editorPort(editor: CustomEditor) {
  const cached = (
    editor as CustomEditor & {
      [PORT]?: ReturnType<typeof createEditorPort>;
    }
  )[PORT];
  if (cached) return cached;
  const port = createEditorPort(editor);
  if (port) Object.defineProperty(editor, PORT, { value: port });
  return port;
}
