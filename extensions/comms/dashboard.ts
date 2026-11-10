import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Editor,
  compositeTuiLine,
  Input,
  matchesKey,
  SelectList,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { createVimEditor } from "../vim/index.ts";
import {
  clean,
  collectionSources,
  errorMessage,
  sources,
  views,
  visibleItems,
  type Item,
  type Source,
  type State,
} from "./state.ts";

export type NextTask = { title: string; due: string | null };
export type ViewState = {
  view: number;
  search: string;
  source?: Source;
  selected?: string;
  task?: string;
};
export type Choice = {
  action: "refresh" | "draft-ai";
  item?: Item;
  view: ViewState;
};
export type DashboardData = {
  state: State;
  reminderList?: string;
  next: NextTask[];
  nextStatus: string;
  nextLoaded: boolean;
  triageStatus?: string;
  triageRunning?: boolean;
};
export type LocalAction =
  | "refresh"
  | "cancel-triage"
  | "reload"
  | "next"
  | "reset-demo"
  | "save-draft"
  | "copy"
  | "open-original"
  | "open-browser"
  | "add-next"
  | "snooze"
  | "waiting"
  | "resolve"
  | "dismiss"
  | "reopen";
export type ActionRequest = {
  action: LocalAction;
  item?: Item;
  text?: string;
};
export type ActionResult = DashboardData & { notice?: string };
type EditState = {
  item: Item;
  action: "save-draft" | "add-next";
  editor: Editor;
  vimEnabled: boolean;
  dispose: () => void;
  original: string;
  discard: boolean;
};

const sourceNames = {
  mail: "Mail",
  teams: "Teams",
  calendar: "Calendar",
  notion: "Notion",
  meetings: "Meetings",
  remarkable: "reMarkable",
};
function singleLine(text: string): string {
  return clean(text).replace(/\s+/g, " ").trim();
}
function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function age(timestamp: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 60000),
  );
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
function itemStatus(item: Item): string {
  if (item.draftStale) return "Review draft";
  if (item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now())
    return "Snoozed";
  return `${item.status}${item.draft ? " · draft ready" : ""}`;
}
function taskKey(task: NextTask): string {
  return JSON.stringify([task.title, task.due]);
}

export class Dashboard implements Component, Focusable {
  private input = new Input({
    prompt: "Search: ",
    placeholder: "person, topic or source",
  });
  private selection = 0;
  private visible: Item[] = [];
  private scroll = 0;
  private pageSize = 1;
  private view: number;
  private source?: Source;
  private selected?: string;
  private task?: string;
  private screen: "list" | "detail" | "coverage" = "list";
  private detailScroll = 0;
  private detailExpanded = false;
  private menu?: {
    item: Item;
    list: SelectList;
    height: number;
    groupBreak?: number;
  };
  private editing?: EditState;
  private notice = "";
  private busy = false;
  private disposed = false;
  private usable = true;
  private hasFocus = false;
  private width = 100;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private data: DashboardData,
    private done: (choice?: Choice) => void,
    private perform: (request: ActionRequest) => Promise<ActionResult>,
    private demo = false,
    initial: ViewState = { view: 0, search: "" },
    private onTerminalInput?: ExtensionUIContext["onTerminalInput"],
  ) {
    this.view = initial.view;
    this.source = initial.source;
    this.input.setValue(initial.search);
    this.selected = initial.selected;
    this.task = initial.task;
    this.refilter();
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncFocus();
  }
  private syncFocus(): void {
    this.input.focused =
      this.hasFocus && this.screen === "list" && !this.menu && !this.editing;
    if (this.editing)
      this.editing.editor.focused = this.hasFocus && !this.editing.discard;
  }
  invalidate(): void {
    this.input.invalidate();
    this.editing?.editor.invalidate();
    this.menu?.list.invalidate();
  }
  dispose(): void {
    this.disposed = true;
    this.focused = false;
    this.closeEditor();
  }
  viewState(): ViewState {
    return {
      view: this.view,
      search: this.input.getValue(),
      source: this.source,
      selected: this.selected,
      task: this.task,
    };
  }
  setData(data: DashboardData): void {
    if (this.disposed) return;
    this.data = data;
    this.refilter();
    this.tui.requestRender();
  }
  setNotice(message: string): void {
    if (this.disposed) return;
    this.notice = singleLine(message);
    this.tui.requestRender();
  }
  private rows(query = this.input.getValue(), view = views[this.view]): Item[] {
    return visibleItems(this.data.state, view, query).filter(
      (item) => !this.source || item.source === this.source,
    );
  }
  private tasks(query = this.input.getValue()): NextTask[] {
    return this.data.next.filter((task) =>
      task.title.toLowerCase().includes(query.toLowerCase()),
    );
  }
  private item(): Item | undefined {
    return this.view === 2
      ? undefined
      : this.visible.find((row) => row.key === this.selected);
  }
  private refilter(): void {
    this.visible = this.rows();
    const list = this.view === 2 ? this.tasks() : this.visible;
    const matches = (row: Item | NextTask) =>
      "key" in row ? row.key === this.selected : taskKey(row) === this.task;
    // Next has no stable reminder IDs. Identical title/due pairs must still be
    // navigable, so retain a matching current index before searching by key.
    const index =
      list[this.selection] && matches(list[this.selection])
        ? this.selection
        : list.findIndex(matches);
    this.selection =
      index >= 0
        ? index
        : Math.max(0, Math.min(this.selection, list.length - 1));
    if (this.view === 2)
      this.task = this.tasks()[this.selection]
        ? taskKey(this.tasks()[this.selection])
        : undefined;
    else this.selected = this.visible[this.selection]?.key;
    if (this.screen === "detail" && !this.item()) this.screen = "list";
    this.syncFocus();
  }
  private finish(action: Choice["action"], item?: Item): void {
    this.done({
      action,
      item: item ? structuredClone(item) : undefined,
      view: this.viewState(),
    });
  }
  private async run(
    action: LocalAction,
    item?: Item,
    text?: string,
  ): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.notice = "Working…";
    this.tui.requestRender();
    try {
      const result = await this.perform({
        action,
        item: item ? structuredClone(item) : undefined,
        text,
      });
      if (this.disposed) return;
      this.data = result;
      this.notice = singleLine(result.notice || "");
      this.menu = undefined;
      if (action === "save-draft" || action === "add-next") this.closeEditor();
      this.refilter();
    } catch (error) {
      if (!this.disposed) this.notice = singleLine(errorMessage(error));
      // Keep unsaved editor text and its original revision on failure.
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.syncFocus();
        this.tui.requestRender();
      }
    }
  }
  private listTheme() {
    return {
      selectedPrefix: (text: string) => this.theme.fg("accent", text),
      selectedText: (text: string) => this.theme.fg("accent", text),
      description: (text: string) => this.theme.fg("muted", text),
      scrollInfo: (text: string) => this.theme.fg("dim", text),
      noMatch: (text: string) => this.theme.fg("dim", text),
    };
  }
  private openActions(item: Item, selected = ""): void {
    // Legacy meeting and scratchpad items keep generic actions only.
    const replies = (collectionSources as readonly string[]).includes(
      item.source,
    );
    const requestActions = [
      ...(replies
        ? [
            { value: "save-draft", label: "Edit local draft" },
            ...(!this.demo
              ? [
                  {
                    value: "draft-ai",
                    label: "Draft with AI · return to queue when ready",
                  },
                ]
              : []),
            ...(item.draft ? [{ value: "copy", label: "Copy draft" }] : []),
          ]
        : []),
      ...(!this.demo && item.url
        ? [
            { value: "open-original", label: "Open original" },
            { value: "open-browser", label: "Open in browser" },
          ]
        : []),
      ...(!this.demo
        ? [
            {
              value: "add-next",
              label: `Add action to Reminders ${this.data.reminderList || "Next"}`,
            },
          ]
        : []),
    ];
    const closed = item.status === "resolved" || item.status === "dismissed";
    const entries = [
      ...requestActions,
      ...(!closed
        ? [
            { value: "snooze", label: "Snooze until tomorrow at 09:00" },
            ...(item.status !== "waiting"
              ? [{ value: "waiting", label: "Mark waiting" }]
              : []),
            { value: "resolve", label: "Resolve locally" },
            { value: "dismiss", label: "Dismiss locally" },
          ]
        : []),
      ...(closed ||
      item.status === "waiting" ||
      (item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now())
        ? [
            {
              value: "reopen",
              label: closed ? "Reopen locally" : "Return to Needs you",
            },
          ]
        : []),
    ];
    // Reserve room for the border, request identity, hints and scroll indicator.
    const maxVisible = Math.max(1, this.tui.terminal.rows - 11);
    const list = new SelectList(
      entries,
      Math.min(entries.length, maxVisible),
      this.listTheme(),
    );
    list.setSelectedIndex(
      Math.max(
        0,
        entries.findIndex((entry) => entry.value === selected),
      ),
    );
    list.onSelect = ({ value }) => {
      this.menu = undefined;
      if (value === "save-draft" || value === "add-next")
        this.openEditor(item, value);
      else if (value === "draft-ai") this.finish(value, item);
      else void this.run(value as LocalAction, item);
      this.syncFocus();
    };
    list.onCancel = () => {
      this.menu = undefined;
      this.syncFocus();
    };
    this.menu = {
      item: structuredClone(item),
      list,
      height: this.tui.terminal.rows,
      groupBreak:
        requestActions.length && entries.length <= maxVisible
          ? requestActions.length
          : undefined,
    };
    this.syncFocus();
  }
  private closeEditor(): void {
    this.editing?.dispose();
    this.editing = undefined;
  }
  private cancelEditor(): void {
    const edit = this.editing;
    if (!edit) return;
    if (edit.editor.getExpandedText() !== edit.original) edit.discard = true;
    else this.closeEditor();
  }
  private openEditor(item: Item, action: EditState["action"]): void {
    this.closeEditor();
    const created = createVimEditor(
      this.tui,
      {
        borderColor: (text) => this.theme.fg("border", text),
        selectList: this.listTheme(),
      },
      this.keys,
      this.onTerminalInput,
      () => this.cancelEditor(),
    );
    const { editor } = created;
    editor.disableSubmit = true;
    const original = action === "save-draft" ? item.draft : item.suggestion;
    editor.setText(original);
    this.editing = {
      item: structuredClone(item),
      action,
      ...created,
      original: editor.getExpandedText(),
      discard: false,
    };
    this.notice = created.vimEnabled
      ? ""
      : "Vim mode is unavailable for this Pi editor. Standard editing still works.";
    this.syncFocus();
  }
  private cancel(): void {
    if (this.screen !== "list") {
      this.screen = "list";
      this.detailScroll = 0;
    } else if (this.input.getValue()) {
      this.input.setValue("");
      this.selection = 0;
      this.refilter();
    } else this.done();
    this.syncFocus();
  }
  handleInput(data: string): void {
    if (this.disposed || this.busy) return;
    this.refilter();
    const cancel = this.keys.matches(data, "tui.select.cancel");
    if (!this.usable) {
      if (cancel && !this.editing) {
        if (this.menu) this.menu = undefined;
        else this.cancel();
        this.syncFocus();
        this.tui.requestRender();
      }
      return;
    }
    if (this.editing) {
      const edit = this.editing;
      if (edit.discard) {
        if (cancel) {
          this.closeEditor();
          this.notice = "Unsaved changes discarded.";
        } else edit.discard = false;
      } else if (cancel && (!edit.vimEnabled || !matchesKey(data, "escape"))) {
        this.cancelEditor();
      } else if (matchesKey(data, "ctrl+s")) {
        void this.run(edit.action, edit.item, edit.editor.getExpandedText());
      } else {
        // A reply editor uses Enter for paragraphs, never sending or saving.
        edit.editor.handleInput(
          this.keys.matches(data, "tui.input.submit") ? "\n" : data,
        );
      }
      this.syncFocus();
    } else if (this.menu) {
      this.menu.list.handleInput(data);
    } else if (cancel) this.cancel();
    else if (matchesKey(data, "ctrl+g")) {
      this.screen = this.screen === "coverage" ? "list" : "coverage";
      this.detailScroll = 0;
      this.syncFocus();
    } else if (matchesKey(data, "ctrl+r")) {
      if (this.demo) void this.run("reset-demo");
      else if (this.view === 2 && this.screen === "list") void this.run("next");
      else void this.run("refresh");
    } else if (
      matchesKey(data, "ctrl+x") &&
      !this.demo &&
      this.data.triageRunning
    )
      void this.run("cancel-triage");
    else if (matchesKey(data, "ctrl+l")) void this.run("reload");
    else if (this.screen === "detail" && matchesKey(data, "i")) {
      this.detailExpanded = !this.detailExpanded;
      // Reveal the requested metadata even when the summary or draft is long.
      this.detailScroll = this.detailExpanded ? Number.MAX_SAFE_INTEGER : 0;
    } else if (this.screen === "detail" && matchesKey(data, "o")) {
      const item = this.item();
      if (!this.demo && item?.url) void this.run("open-original", item);
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const item = this.item();
      if (this.screen === "detail" && item) this.openActions(item);
      else if (this.screen === "list" && item) {
        this.screen = "detail";
        this.detailScroll = 0;
        this.detailExpanded = false;
        this.notice = "";
        this.syncFocus();
      }
    } else {
      let offset = 0;
      if (this.keys.matches(data, "tui.select.up")) offset = -1;
      else if (this.keys.matches(data, "tui.select.down")) offset = 1;
      else if (this.keys.matches(data, "tui.select.pageUp"))
        offset = -this.pageSize;
      else if (this.keys.matches(data, "tui.select.pageDown"))
        offset = this.pageSize;
      if (offset && this.screen !== "list")
        this.detailScroll = Math.max(0, this.detailScroll + offset);
      else if (offset) {
        const list = this.view === 2 ? this.tasks() : this.visible;
        this.selection = Math.max(
          0,
          Math.min(list.length - 1, this.selection + offset),
        );
        if (this.view === 2)
          this.task = this.tasks()[this.selection]
            ? taskKey(this.tasks()[this.selection])
            : undefined;
        else this.selected = this.visible[this.selection]?.key;
        this.notice = "";
      } else if (this.screen === "list") {
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
          this.view =
            (this.view + (matchesKey(data, "tab") ? 1 : views.length - 1)) %
            views.length;
          this.selection = 0;
          this.scroll = 0;
          this.notice = "";
          this.refilter();
        } else if (matchesKey(data, "ctrl+o") && this.view !== 2) {
          const options: Array<Source | undefined> = [undefined, ...sources];
          this.source =
            options[(options.indexOf(this.source) + 1) % options.length];
          this.selection = 0;
          this.scroll = 0;
          this.refilter();
        } else {
          const before = this.input.getValue();
          this.input.handleInput(data);
          if (this.input.getValue() !== before) {
            this.selection = 0;
            this.scroll = 0;
            this.refilter();
          }
        }
      }
    }
    this.tui.requestRender();
  }

  private coverage(): { text: string; incomplete: boolean } {
    const counts = { unchecked: 0, partial: 0, unavailable: 0 };
    for (const source of collectionSources) {
      const entries = this.data.state.coverage.filter(
        (entry) => entry.source === source,
      );
      if (!entries.length) counts.unchecked++;
      for (const entry of entries)
        if (entry.status !== "complete") counts[entry.status]++;
    }
    const failures = Object.entries(counts)
      .filter(([, count]) => count)
      .map(([status, count]) => `${count} ${status}`);
    return {
      incomplete: failures.length > 0,
      text: failures.length
        ? `Coverage incomplete · ${failures.join(" · ")} · ^G details`
        : "Last checks reported complete · ^G coverage",
    };
  }
  private detailLines(item: Item, width: number): string[] {
    const th = this.theme;
    // Sanitize source text before styling, and style each wrapped line so theme
    // attributes survive terminal line resets without widening the reading area.
    const text = (value: string, style = (line: string) => line) =>
      clean(value, 20000)
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map(style);
    const muted = (line: string) => th.fg("muted", line);
    const bold = (line: string) => th.bold(line);
    const lines = [
      ...text(item.title, bold),
      ...text(`${item.person} · ${sourceNames[item.source]}`, muted),
      "",
      th.bold("Next action"),
      ...text(
        item.suggestion || "Review the original before choosing an action.",
        bold,
      ),
      ...(item.reminderAdded
        ? text(
            `Added to ${this.data.reminderList || "Next"}: ${item.reminderAdded}`,
            muted,
          )
        : []),
      "",
      ...text(
        (collectionSources as readonly string[]).includes(item.source)
          ? "AI summary · not the original message"
          : "Legacy capture · Comms no longer collects this source",
        muted,
      ),
      ...text(item.summary),
    ];
    if (item.uncertainty?.trim())
      lines.push(
        "",
        th.fg("warning", "Not verified"),
        ...text(item.uncertainty),
      );
    if (item.draft.trim())
      lines.push(
        "",
        ...text("Local reply draft · not sent", muted),
        ...(item.draftStale
          ? text("Source changed. Review this draft before using it.", (line) =>
              th.fg("warning", line),
            )
          : []),
        ...text(item.draft),
      );
    lines.push(
      "",
      ...text(
        !this.demo && item.url
          ? "o Open original"
          : item.url
            ? "Original opening disabled in demo"
            : "No source link available",
        !this.demo && item.url ? (line) => th.fg("accent", line) : muted,
      ),
      ...text(`i ${this.detailExpanded ? "Hide" : "Show"} details`, muted),
    );
    if (this.detailExpanded)
      lines.push(
        "",
        ...text(`Account: ${item.account}`, muted),
        ...text(
          `Local status: ${itemStatus(item)} · Priority ${item.priority}`,
          muted,
        ),
        ...text(`Source updated: ${item.sourceUpdatedAt}`, muted),
        ...(item.snoozedUntil
          ? text(`Snoozed until: ${item.snoozedUntil}`, muted)
          : []),
        ...(item.url ? text(`Original: ${item.url}`, muted) : []),
      );
    return lines;
  }
  private coverageLines(): string[] {
    return [
      "Saved source checks · not a live inbox guarantee",
      "",
      ...collectionSources.flatMap((source) => {
        const entries = this.data.state.coverage.filter(
          (entry) => entry.source === source,
        );
        if (!entries.length) return [`${sourceNames[source]} · unchecked`, ""];
        return entries.flatMap((entry) => [
          `${sourceNames[source]} · ${entry.account} · ${entry.status}`,
          `Checked: ${entry.checkedAt}`,
          `Checkpoint: ${entry.cursor || "None"}`,
          entry.detail,
          "",
        ]);
      }),
      `Reminders ${this.data.reminderList || "Next"}: ${this.data.nextStatus}`,
      ...(this.data.triageStatus ? [`Triage: ${this.data.triageStatus}`] : []),
    ];
  }
  private emptyLabel(): string {
    if (this.input.getValue()) return "No matches. Esc clears search.";
    if (this.view === 2)
      return this.data.nextLoaded
        ? `No open ${this.data.reminderList || "Next"} tasks in the cached read.`
        : `${this.data.reminderList || "Next"} not loaded. Ctrl+R reads Reminders.`;
    return "No retained requests in this view. Ctrl+R starts triage.";
  }
  private tableLine(width: number, item?: Item, index = 0): string {
    const source = width >= 55 ? 9 : 0;
    const person = width >= 75 ? 19 : 0;
    const status = width >= 105 ? 16 : 0;
    const updated = width >= 65 ? 8 : 0;
    const title = width - 4 - source - person - status - updated;
    return (
      pad(
        item ? `${index === this.selection ? "›" : " "}${item.priority}` : " P",
        4,
      ) +
      (source ? pad(item ? sourceNames[item.source] : "Source", source) : "") +
      (person
        ? pad(item ? singleLine(item.person) : "Person", person - 1) + " "
        : "") +
      pad(item ? singleLine(item.title) : "Request", title - 1) +
      " " +
      (status
        ? pad(item ? itemStatus(item) : "Local status", status - 1) + " "
        : "") +
      (updated
        ? pad(item ? age(item.sourceUpdatedAt) : "Updated", updated)
        : "")
    );
  }
  private actionDialog(width: number, height: number): string[] {
    if (this.menu!.height !== height)
      this.openActions(
        this.menu!.item,
        this.menu!.list.getSelectedItem()?.value,
      );
    const menu = this.menu!;
    const th = this.theme;
    const innerWidth = width - 4;
    const choices = menu.list.render(innerWidth);
    if (menu.groupBreak) choices.splice(menu.groupBreak, 0, "");
    const body = [
      th.bold("Request actions"),
      th.fg(
        "muted",
        singleLine(`${menu.item.person} · ${sourceNames[menu.item.source]}`),
      ),
      singleLine(menu.item.title),
      "",
      ...choices,
      "",
      ...wrapTextWithAnsi("↑↓ choose · Enter apply · Esc back", innerWidth).map(
        (line) => th.fg("dim", line),
      ),
    ];
    const edge = (left: string, right: string) =>
      th.fg("border", `${left}${"─".repeat(width - 2)}${right}`);
    return [
      edge("╭", "╮"),
      ...body.map(
        (line) =>
          th.fg("border", "│") +
          ` ${pad(line, innerWidth)} ` +
          th.fg("border", "│"),
      ),
      edge("╰", "╯"),
    ];
  }
  private frame(lines: string[], width: number, height: number): string[] {
    const margin = width > 2 ? " " : "";
    const result = lines
      .slice(0, height)
      .map((line) => pad(margin + truncateToWidth(line, this.width), width));
    while (result.length < height) result.push(" ".repeat(Math.max(1, width)));
    if (!this.menu || !this.usable || this.editing) return result;
    const dialogWidth = Math.min(76, width - 4);
    const dialog = this.actionDialog(dialogWidth, height);
    const background = result.map((line) =>
      this.theme.fg("dim", stripTerminalSequences(line)),
    );
    const top = Math.max(0, Math.floor((height - dialog.length) / 2));
    const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
    for (const [index, line] of dialog.entries())
      background[top + index] = compositeTuiLine(
        background[top + index],
        line,
        left,
        dialogWidth,
        width,
      );
    return background;
  }
  render(width: number): string[] {
    // Snoozes can expire while this view is open. Keep the highlighted row and
    // the action target tied to the same stable key as the visible order changes.
    this.refilter();
    const height = Math.max(1, this.tui.terminal.rows);
    const w = (this.width = Math.max(1, Math.min(120, width - 2)));
    const th = this.theme;
    const health = this.coverage();
    this.usable = w >= 33 && height >= 14;
    const title =
      th.bold(this.demo ? "Comms · DEMO · no external actions" : "Comms") +
      th.fg(
        "dim",
        this.view === 2
          ? ` · Reminders ${this.data.reminderList || "Next"}`
          : ` · ${this.source ? sourceNames[this.source] : "All sources"}`,
      );
    const healthLine = th.fg(
      health.incomplete ? "warning" : "dim",
      health.text,
    );
    if (!this.usable)
      return this.frame(
        [
          title,
          healthLine,
          this.editing
            ? "Editor paused. Enlarge terminal; unsaved text is retained."
            : "Enlarge terminal for the table. Esc goes back.",
        ],
        width,
        height,
      );
    if (this.editing) {
      const edit = this.editing;
      const lines = [
        title,
        th.bold(
          edit.action === "save-draft"
            ? "Local reply draft · save never sends"
            : `Reminders ${this.data.reminderList || "Next"} · save adds one action`,
        ),
        singleLine(`${edit.item.person} · ${edit.item.title}`),
        th.fg(
          "warning",
          edit.discard
            ? "Unsaved changes. Esc again discards; any other key keeps editing."
            : edit.item.draftStale
              ? "Source changed. Review the complete draft before saving."
              : "",
        ),
        ...edit.editor.render(w),
      ];
      while (lines.length < height - 2) lines.push("");
      lines.push(
        th.fg("warning", this.notice),
        th.fg(
          "dim",
          this.busy
            ? "Working · wait for the result before retrying"
            : edit.vimEnabled
              ? "Ctrl+S save · Enter newline · Esc NORMAL, then back"
              : "Ctrl+S save · Enter newline · Esc back",
        ),
      );
      return this.frame(lines, width, height);
    }
    const tabs = views
      .map((name, i) => {
        const count =
          i === 2
            ? this.data.nextLoaded
              ? this.data.next.length
              : "?"
            : this.rows("", name).length;
        const text = ` ${name} ${count} `;
        return i === this.view
          ? th.bg("selectedBg", th.bold(text))
          : th.fg("dim", text);
      })
      .join(" ");
    const lines = [
      title,
      healthLine,
      visibleWidth(tabs) <= w
        ? tabs
        : th.fg("accent", `${views[this.view]} · Tab views`),
      ...(this.screen === "list"
        ? this.input.render(w)
        : [
            th.fg(
              "dim",
              this.screen === "coverage"
                ? "Source coverage"
                : "Request details",
            ),
          ]),
      th.fg("border", "─".repeat(w)),
    ];
    if (this.screen !== "list") {
      const item = this.item();
      const content =
        this.screen === "coverage"
          ? this.coverageLines().flatMap((text) =>
              clean(text, 20000)
                .split("\n")
                .flatMap((line) => wrapTextWithAnsi(line, w)),
            )
          : item
            ? this.detailLines(item, Math.min(80, w))
            : ["This request is no longer in the current view."];
      const available = height - lines.length - 2;
      this.pageSize = available;
      this.detailScroll = Math.min(
        this.detailScroll,
        Math.max(0, content.length - available),
      );
      lines.push(
        ...content.slice(this.detailScroll, this.detailScroll + available),
      );
      while (lines.length < height - 2) lines.push("");
      lines.push(
        th.fg("warning", this.notice),
        th.fg(
          "dim",
          this.screen === "coverage"
            ? "Up/Down scroll · ^L reload local · Esc back"
            : w >= 60
              ? `${!this.demo && item?.url ? "o original · " : ""}i ${this.detailExpanded ? "hide details" : "details"} · ↑↓ scroll · Enter actions · Esc list`
              : "i info · ↑↓ · Enter actions · Esc",
        ),
      );
      return this.frame(lines, width, height);
    }
    const taskView = this.view === 2;
    const list = taskView ? this.tasks() : this.visible;
    lines.push(
      th.fg(
        "dim",
        taskView ? pad("  Next action", w - 12) + "Due" : this.tableLine(w),
      ),
    );
    const bodyHeight = Math.max(1, height - lines.length - 6);
    this.pageSize = bodyHeight;
    if (this.selection < this.scroll) this.scroll = this.selection;
    if (this.selection >= this.scroll + bodyHeight)
      this.scroll = this.selection - bodyHeight + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, list.length - bodyHeight));
    for (let i = 0; i < bodyHeight; i++) {
      const index = this.scroll + i;
      const item = list[index];
      if (!item) {
        lines.push(i === 0 ? th.fg("muted", this.emptyLabel()) : "");
        continue;
      }
      const text =
        "key" in item
          ? this.tableLine(w, item, index)
          : pad(
              `${index === this.selection ? "›" : " "} ${singleLine(item.title)}`,
              w - 12,
            ) + singleLine(item.due || "");
      lines.push(
        index === this.selection
          ? th.bg("selectedBg", th.fg("text", text))
          : th.fg(
              "key" in item && item.priority === 1 ? "warning" : "text",
              text,
            ),
      );
    }
    const item = this.item();
    const task = taskView ? this.tasks()[this.selection] : undefined;
    lines.push(
      th.fg("border", "─".repeat(w)),
      th.bold(
        item
          ? singleLine(
              `${item.person} · ${sourceNames[item.source]} · ${itemStatus(item)}`,
            )
          : task
            ? singleLine(task.title)
            : "",
      ),
      th.fg(
        "muted",
        item
          ? `AI summary: ${singleLine(item.summary)}`
          : task
            ? `Due: ${singleLine(task.due || "No due date")}`
            : "",
      ),
      th.fg(
        item?.draftStale ? "warning" : "muted",
        item
          ? item.draftStale
            ? "Source changed. Review the saved draft before using it."
            : `Suggested action: ${singleLine(item.suggestion)}`
          : taskView
            ? singleLine(this.data.nextStatus)
            : "",
      ),
      th.fg(
        this.notice ? "warning" : "dim",
        this.notice ||
          (this.data.triageStatus ? singleLine(this.data.triageStatus) : "") ||
          `${this.selection + (list.length ? 1 : 0)}/${list.length} shown · Saved queue · ^L reload local`,
      ),
      th.fg(
        "dim",
        this.busy
          ? "Working · wait for the result before retrying"
          : this.data.triageRunning
            ? "Claude triage running · ^X cancel · ^L reload local · Esc"
            : w >= 90
              ? "Tab views · Enter details · ^O source · ^R triage · ^G coverage · Esc"
              : "Tab views · Enter details · ^R refresh · Esc",
      ),
    );
    return this.frame(lines, width, height);
  }
}
