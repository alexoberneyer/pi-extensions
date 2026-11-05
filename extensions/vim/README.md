# Personal Vim prompt editor

A small Vim layer for Pi's existing prompt editor. No dependencies, subprocesses
or Neovim configuration. Starts in INSERT and returns there after submitting,
clearing or replacing a prompt. The bottom border shows INSERT or NORMAL.

Comms uses the same editor for local replies and Next actions. There, Escape in
NORMAL returns to Comms with its unsaved-change confirmation instead of
interrupting Pi. Ctrl+S saves, Enter inserts a newline, and nothing is sent.

## Keys

| Key in NORMAL             | Action                                                |
| ------------------------- | ----------------------------------------------------- |
| `i` / `a`                 | Insert before / after the current character           |
| `I` / `A`                 | Insert at the first nonblank / end of the line        |
| `h` / `l`                 | Previous / next character, within the line            |
| `j` / `k`                 | Next / previous logical line, never prompt history    |
| `w` / `b` / `e`           | Next word start / previous word start / word end      |
| `0` / `$`                 | First / last character on the line                    |
| `f` / `F` + character     | Next / previous match on the line                     |
| `t` / `T` + character     | Just before / just after that match                   |
| `;` / `,`                 | Repeat the last search / in the other direction       |
| `x`                       | Delete the character under the cursor                 |
| `u`                       | Undo the last edit                                    |
| `Ctrl+R`                  | Redo the last undone edit                             |
| `c{motion}` / `d{motion}` | Change / delete with any motion above but `j/k`       |
| `cc` / `dd`               | Change the line with indentation / delete the line    |
| `C` / `D`                 | Change / delete to the end of the line                |
| `{count}{command}`        | Repeat any command above but `i/a/I/A`, such as `10w` |

A pending count, `c`, `d`, `f`, `F`, `t` or `T` appears in the border, such
as `2dt`. The motion selects the range. Changes enter INSERT. Deletions stay in NORMAL.
`cw` on a word keeps its following spaces. `dw` also removes the following
spacing on that line.

The key after `f/F/t/T` is always the target, even `c` or `;`. Searches stay on
the line, unlike Pi's own `Ctrl+]` jump. A missing target cancels the command:
`ct.` without a `.` stays in NORMAL. `;` and `,` move past an adjacent match, as
Neovim does. One deviation: Vim's `Te` stops inside a decomposed `é` (`e` plus
a combining accent). Here the character stays whole.

Counts before and after an operator multiply, so `2d3w` deletes six words.
`0` moves to the line start until a count has begun, as in `10w`. Counts stop at
the ends of the prompt, but `2dd`, `2D` and `3$` on the last line do nothing, as
in Vim. Counts on `i/a/I/A` are ignored instead of repeating the inserted text.

Escape cancels a pending count, operator or search without interrupting Pi.
Unsupported suffixes, native shortcuts and pastes also cancel it. A second
Escape in NORMAL reaches Pi.

Escape closes an open completion picker first. Otherwise, it leaves INSERT for
NORMAL, moving the cursor one character left as Vim does. Escape in NORMAL goes
to Pi, including interrupting a running agent. With a completion picker open,
interrupting from INSERT takes three Escapes instead of two.

Enter, Tab, arrows, Ctrl/Alt shortcuts, image paste and bracketed text pastes
stay with Pi. Arrows retain Pi's prompt-history navigation. Unsupported printable
keys in NORMAL do nothing. `j/k` use logical lines, not wrapped screen rows.
Characters include emoji and combining marks. Collapsed paste markers stay
atomic, including when deleted and undone.

Each change and its replacement text through Escape form one undo step.
Each deletion is one step. Plain INSERT typing keeps Pi's native grouping.
Deleting text does not write to the clipboard or a Vim register.

In NORMAL, `Ctrl+R` restores successive undone edits, including grouped changes.
An empty redo history does nothing. Redo restores saved text, cursor position and
collapsed-paste data. New edits, text replacements and submission clear redo.
Motions and mode changes without typing keep it. INSERT shortcuts stay with Pi.
Redo history is local to the current editor; reload clears it. This is a linear
history, not Vim's undo tree.

No text objects (`ciw`, `di"`), Visual mode, repeat (`.`), search, macros, Ex
commands or key-remapping configuration. Word classes follow common
clean-Vim defaults, not a custom Neovim `iskeyword` configuration.

## Install and verify

Enable this extension through the package's `pi config` selection.
Run `/reload` in each Pi instance that should use it.
Only interactive Pi installs the editor. Print/RPC/subagent sessions are unchanged.
Another extension that already owns the editor takes precedence, with a warning.

Try without installing the package:

```sh
pi -e /absolute/path/to/pi-extensions/extensions/vim/index.ts
```

Tests use the installed Pi loader and editor without credentials or model calls.
PTY tests exercise editing and `/reload` in Pi's regular and fullscreen modes.
When Neovim is installed, word, search, count and operator fixtures also run
against `nvim --clean`:

```sh
node scripts/test.mjs tests/vim.test.mjs
npm run lint:check
```

## Code map and upgrade boundary

- `index.ts`: modes, input routing and the border label. Its shared
  `createVimEditor` factory installs the input observer and returns its cleanup
  function for both the prompt and Comms. Extends `CustomEditor` so Pi still
  owns rendering, completion, history and application shortcuts.
- `motions.ts`: pure `w/b/e` and `f/F/t/T` movement and word classes.
- `operators.ts`: shared change/delete ranges, including counts and Vim's
  line-boundary rules.
- `editor-port.ts`: guarded private Pi integration. Reuses native grapheme/paste
  segmentation and full undo/redo snapshots. Native undo/edit hooks keep redo
  consistent with Pi shortcuts and async completion. It also observes input before the fullscreen
  viewport, so PageUp cannot leave a destructive prefix armed. Pi currently has
  no public pre-viewport input hook. Listeners are removed on reload, editor
  recreation and shutdown.

Tested with Pi 1.5.0. After a Pi upgrade, rerun the tests. The command above
follows the managed install's current version.
Missing adapter methods disable Vim mode with a warning instead of blocking
normal typing. Shape checks cannot detect every change in upstream behavior.
