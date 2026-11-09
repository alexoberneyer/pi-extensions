import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { LaunchForm } from "./launch-form.ts";
import type { Launcher, LaunchResult } from "./launch.ts";
import type { AgentOpener } from "./attach.ts";
import { assertCloseablePane, type PaneCloser } from "./close.ts";
import { isTmuxTarget, type TmuxTarget } from "./tmux-target.ts";
import { isRemoteTmuxTarget, type AgentTarget } from "./remote-target.ts";
import {
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
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  age,
  filterRows,
  filters,
  plain,
  statuses,
  sources,
  type AgentSource,
  type AgentRow,
} from "./state.ts";

const CONTENT_WIDTH = 100;
type ClosePrompt = {
  key: string;
  title: string;
  cwd: string;
  source: string;
  target: TmuxTarget;
  focused: boolean;
  menu: SelectList;
};
const enterLabels = {
  return: "Return to current Pi",
  attach: "Attach local tmux",
  remote: "Attach dev01 tmux",
  resume: "Resume saved Pi",
  command: "Show command",
  terminal: "Terminal guidance",
} as const;

const priority = {
  waiting: 0,
  error: 1,
  stopped: 2,
  working: 3,
  ready: 4,
  unknown: 5,
  inactive: 6,
};
const attentionReasons: Partial<Record<AgentRow["status"], string>> = {
  waiting: "Input or approval",
  error: "Error reported",
  stopped: "Run stopped",
};
const colors = {
  waiting: "warning",
  working: "accent",
  ready: "success",
  error: "error",
  stopped: "warning",
  unknown: "muted",
  inactive: "dim",
} as const;

function sourceLabel(row: AgentRow): string {
  return `${sources[row.source]}${row.host ? ` · ${plain(row.host, 80)}` : ""}`;
}

function connectionLabel(row: AgentRow): string {
  const connection = terminalConnectionLabel(row);
  return row.nativeId
    ? `${connection} · Conversation ${plain(row.nativeId, 200)}`
    : connection;
}

function terminalConnectionLabel(row: AgentRow): string {
  const target = row.host ? row.remoteTmux : row.tmux;
  const tmux = target
    ? `tmux · ${row.tmuxName ? `${plain(row.tmuxName, 80)} · ` : ""}Session ${target.session} · Pane ${target.pane || "n/a"}`
    : "";
  if (row.host)
    return `Connection: Remote host ${plain(row.host, 80)}${tmux ? ` · ${tmux}` : ""}`;
  if (tmux) return `Connection: Local ${tmux}`;
  if (row.status === "inactive" && !row.owners.length)
    return "Connection: Saved conversation";
  const pids = row.owners.length
    ? row.owners.map((owner) => owner.pid).join(", ")
    : row.pid;
  return `Connection: Original terminal${pids ? ` · PID ${pids}` : ""}`;
}

function allowsPaneAction(row: AgentRow): boolean {
  return (
    row.source !== "pi" ||
    row.owners.length === 1 ||
    (row.tmuxAgent === "pi" && row.owners.length === 0)
  );
}

function projectKey(row: AgentRow): string {
  return `${row.host || ""}\0${row.cwd}`;
}

function projectLabel(row: AgentRow): string {
  const cwd = row.cwd;
  if (row.host)
    return `${plain(row.host, 80)} · ${plain(cwd) || "Unknown project"}`;
  const home = homedir();
  return (
    plain(
      cwd === home
        ? "~"
        : cwd.startsWith(`${home}/`)
          ? `~${cwd.slice(home.length)}`
          : cwd,
    ) || "Unknown project"
  );
}

export class Dashboard implements Component, Focusable {
  private input = new Input({
    prompt: "Search: ",
    placeholder: "title, project or message",
  });
  private rows: AgentRow[] = [];
  private visible: AgentRow[] = [];
  private selected?: string;
  private selectionMissing = false;
  private filter = 0;
  private projectOnly = false;
  private sourceIndex = 0;
  private sourceOptions: Array<AgentSource | undefined> = [
    undefined,
    ...(Object.keys(sources) as AgentSource[]),
  ];
  private scroll = 0;
  private pageSize = 10;
  private renderedWidth = CONTENT_WIDTH + 2;
  private loading = "Loading saved sessions…";
  private notice = "";
  private disposed = false;
  private form?: LaunchForm;
  private launchAbort?: AbortController;
  private attachAbort?: AbortController;
  private closeAbort?: AbortController;
  private closePrompt?: ClosePrompt;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private cwd: string,
    private done: (row?: AgentRow) => void,
    private refresh: () => void,
    private cleanup: () => void,
    private copyCommand?: (command: string) => Promise<void>,
    private launcher?: Launcher,
    private remoteLaunch = true,
    private opener?: AgentOpener,
    private closer?: PaneCloser,
  ) {}

  get focused(): boolean {
    return (
      this.form?.focused ?? this.closePrompt?.focused ?? this.input.focused
    );
  }
  set focused(value: boolean) {
    this.input.focused = value && !this.form && !this.closePrompt;
    if (this.form) this.form.focused = value;
    if (this.closePrompt) this.closePrompt.focused = value;
  }

  private newAgent(): void {
    if (!this.launcher) {
      this.setNotice("New agent launching requires the Mac dashboard.");
      return;
    }
    if (this.launchAbort) {
      this.setNotice(
        "The previous launch request is still settling. Check agents before retrying.",
      );
      return;
    }
    const closeForm = () => {
      if (this.form !== form) return;
      this.input.focused = form.focused;
      form.dispose();
      this.form = undefined;
    };
    const openLaunched = (result: LaunchResult) => {
      if (this.form !== form || this.disposed) return;
      const target = result.remoteTmux || result.tmux;
      if (!target || !this.opener) {
        form.reportFailure(
          "Agent started, but opening is unavailable. Find it in Agents before retrying.",
        );
        return;
      }
      form.reportOpening();
      this.openAgent(target, closeForm, (message) =>
        form.reportOpenFailure(message, () => openLaunched(result)),
      );
    };
    const form = new LaunchForm(
      this.tui,
      this.theme,
      this.keys,
      this.cwd,
      this.remoteLaunch,
      (request) => {
        if (!request) {
          closeForm();
          if (this.launchAbort) {
            this.launchAbort.abort();
            this.setNotice(
              "Launch may have started. Check local tmux or dev01 before retrying.",
            );
          }
          this.tui.requestRender();
          return;
        }
        const controller = new AbortController();
        this.launchAbort = controller;
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return this.launcher!(request, controller.signal);
          })
          .then(
            (result) => {
              if (this.disposed || controller.signal.aborted) return;
              this.refresh();
              openLaunched(result);
            },
            (error) => {
              if (this.disposed || controller.signal.aborted) return;
              form.reportFailure(`Launch failed: ${String(error)}`);
              this.setNotice(`Launch failed: ${String(error)}`);
            },
          )
          .finally(() => {
            if (this.launchAbort === controller) this.launchAbort = undefined;
          });
      },
    );
    form.focused = this.focused;
    this.input.focused = false;
    this.form = form;
    this.tui.requestRender();
  }

  private openAgent(
    target: AgentTarget,
    onOpened?: () => void,
    onFailure?: (message: string) => void,
  ): void {
    if (!this.opener || this.attachAbort || this.disposed) return;
    const controller = new AbortController();
    const selected = this.selected;
    this.attachAbort = controller;
    this.setNotice("Opening agent… The existing agent stays running.");
    void Promise.resolve()
      .then(() => this.opener!(target, controller.signal))
      .then(
        (result) => {
          if (this.disposed) return;
          this.setNotice(
            result === "switched"
              ? "Opened local tmux agent. Switch back to the dashboard session or window to return."
              : result === "window"
                ? `${"host" in target ? "Opened dev01 in another tmux window." : "Opened agent in another local tmux window."} Switch back here to return to Agents.`
                : "Returned to Agents. Detaching leaves the agent running.",
          );
          onOpened?.();
        },
        (error) => {
          if (this.disposed) return;
          const message = `Cannot open agent: ${String(error)}`;
          this.setNotice(message);
          onFailure?.(message);
        },
      )
      .finally(() => {
        if (this.attachAbort === controller) this.attachAbort = undefined;
        if (this.disposed) return;
        if (
          !this.selectionMissing &&
          this.visible.some((row) => row.key === selected)
        )
          this.selected = selected;
        this.refresh();
        this.tui.requestRender();
      });
  }

  private closeTarget(row?: AgentRow): TmuxTarget {
    if (!row) throw new Error("Select a local tmux pane first.");
    if (row.host || !row.tmux)
      throw new Error("Closing is available only for local tmux panes.");
    if (row.current)
      throw new Error("Cannot close the current dashboard session.");
    if (!allowsPaneAction(row))
      throw new Error("Cannot close a Pi pane with ambiguous ownership.");
    assertCloseablePane(row.tmux);
    return { ...row.tmux };
  }

  private renderCloseConfirmation(prompt: ClosePrompt): string[] {
    const width = Math.min(
      76,
      Math.min(
        this.renderedWidth,
        this.tui.terminal.columns ?? this.renderedWidth,
      ) - 2,
    );
    const innerWidth = width - 4;
    const identity = `Session ${prompt.target.session} · Pane ${prompt.target.pane}`;
    const tooSmall = () =>
      new Error("Enlarge the terminal to review the close confirmation.");
    if (innerWidth < visibleWidth(identity)) throw tooSmall();
    const th = this.theme;
    const body = [
      th.bold("Close tmux pane?"),
      `${prompt.source} · This Mac · ${prompt.title}`,
      `Project: ${prompt.cwd}`,
      identity,
      "",
      ...wrapTextWithAnsi(
        "Abrupt terminal close. Running work can be interrupted.",
        innerWidth,
      ).map((line) => th.fg("warning", line)),
      ...wrapTextWithAnsi(
        "History stays. Daemon-backed work may keep running.",
        innerWidth,
      ).map((line) => th.fg("dim", line)),
      "",
      ...prompt.menu.render(innerWidth),
      "",
      ...wrapTextWithAnsi(
        "↑↓ choose · Enter confirms · Esc cancels",
        innerWidth,
      ).map((line) => th.fg("dim", line)),
    ];
    if (body.length + 4 > this.tui.terminal.rows) throw tooSmall();
    return this.dialog(body, width);
  }

  private dialog(body: string[], width: number): string[] {
    const th = this.theme;
    const innerWidth = width - 4;
    const edge = (left: string, right: string) =>
      th.fg("border", `${left}${"─".repeat(width - 2)}${right}`);
    return [
      edge("╭", "╮"),
      ...body.map((line) => {
        const text = truncateToWidth(line, innerWidth);
        return (
          th.fg("border", "│") +
          ` ${text}${" ".repeat(innerWidth - visibleWidth(text))} ` +
          th.fg("border", "│")
        );
      }),
      edge("╰", "╯"),
    ];
  }

  private confirmClose(): void {
    if (!this.closer) {
      this.setNotice("Pane closing is unavailable in this dashboard.");
      return;
    }
    try {
      const row = this.selectedRow();
      if (!row) throw new Error("Select a local tmux pane first.");
      const target = this.closeTarget(row);
      const menu = new SelectList(
        [
          { value: "cancel", label: "Cancel" },
          { value: "close", label: "Close tmux pane" },
        ],
        2,
        {
          selectedPrefix: (text) => this.theme.fg("accent", text),
          selectedText: (text) => this.theme.fg("accent", text),
          description: (text) => this.theme.fg("muted", text),
          scrollInfo: (text) => this.theme.fg("dim", text),
          noMatch: (text) => this.theme.fg("dim", text),
        },
      );
      const prompt = {
        key: row.key,
        title: plain(row.title, 160),
        cwd: plain(row.cwd),
        source: sourceLabel(row),
        target,
        focused: this.focused,
        menu,
      };
      this.renderCloseConfirmation(prompt);
      this.closePrompt = prompt;
      this.input.focused = false;
      this.tui.requestRender();
    } catch (error) {
      this.setNotice(`Cannot close pane: ${String(error)}`);
    }
  }

  private finishClose(confirmed: boolean): void {
    const prompt = this.closePrompt;
    if (!prompt) return;
    this.closePrompt = undefined;
    this.input.focused = prompt.focused;
    if (!confirmed) {
      this.setNotice("Close cancelled. Nothing was stopped or deleted.");
      return;
    }
    try {
      // Polling can replace rows while confirming. Never act on the new selection.
      const target = this.closeTarget(
        this.rows.find((row) => row.key === prompt.key),
      );
      this.renderCloseConfirmation(prompt);
      if (
        target.socket !== prompt.target.socket ||
        target.session !== prompt.target.session ||
        target.pane !== prompt.target.pane
      )
        throw new Error(
          "That pane changed. Refresh /agents and confirm again.",
        );
      const controller = new AbortController();
      this.closeAbort = controller;
      this.setNotice("Closing tmux pane… No automatic retry.");
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.closer!(target, controller.signal);
        })
        .then(
          () =>
            this.setNotice("Tmux pane closed. Saved history was not deleted."),
          (error) =>
            this.setNotice(
              `Cannot confirm pane closure: ${String(error)}. Refresh before retrying.`,
            ),
        )
        .finally(() => {
          if (this.closeAbort === controller) this.closeAbort = undefined;
          if (!this.disposed) {
            this.refresh();
            this.tui.requestRender();
          }
        });
    } catch (error) {
      this.setNotice(`Cannot close pane: ${String(error)}`);
    }
  }

  setData(rows: AgentRow[], loading = ""): void {
    if (this.disposed) return;
    this.rows = rows;
    this.loading = loading;
    this.refilter(this.filter === 1);
    this.tui.requestRender();
  }

  setNotice(message: string): void {
    if (this.disposed) return;
    this.notice = plain(message);
    this.tui.requestRender();
  }

  selectedRow(): AgentRow | undefined {
    return this.visible.find((row) => row.key === this.selected);
  }

  private enterAction(row: AgentRow): keyof typeof enterLabels {
    if (row.source === "pi" && !row.host && row.current) return "return";
    if (
      row.host === "dev01" &&
      row.live &&
      this.opener &&
      isRemoteTmuxTarget(row.remoteTmux)
    )
      return "remote";
    if (
      !row.host &&
      this.opener &&
      isTmuxTarget(row.tmux) &&
      allowsPaneAction(row)
    )
      return "attach";
    if (row.source === "pi" && !row.host) {
      if (row.owners.length) return "terminal";
      if (row.status === "inactive" && row.sessionFile && !row.tmux)
        return "resume";
    }
    return row.nativeCommand ? "command" : "terminal";
  }

  private actionLabel(row?: AgentRow): string {
    if (!row) return "";
    const action = this.enterAction(row);
    const detail =
      action === "attach"
        ? process.env.TMUX
          ? "Switch to agent · switch back to return"
          : "tmux detach returns to Agents"
        : action === "remote"
          ? process.env.TMUX
            ? "New local tmux window · switch back to return"
            : "SSH here · remote tmux detach returns to Agents"
          : action === "resume"
            ? "Confirm this conversation is closed elsewhere"
            : action === "terminal"
              ? row.owners.length > 1
                ? "Multiple tracked owners. Do not resume."
                : row.detail || "Use its original terminal."
              : action === "return"
                ? row.model
                : "";
    return `Enter: ${enterLabels[action]}${detail ? ` · ${plain(detail)}` : ""}`;
  }

  private refilter(preserveMissingSelection = false): void {
    this.visible = filterRows(
      this.rows,
      this.filter,
      this.input.getValue(),
      this.projectOnly ? this.cwd : undefined,
      this.sourceOptions[this.sourceIndex],
    ).sort((a, b) => {
      if (this.filter === 1)
        return (
          priority[a.status] - priority[b.status] ||
          Number(!a.updated) - Number(!b.updated) ||
          a.updated - b.updated ||
          a.key.localeCompare(b.key)
        );
      if (a.host !== b.host) return (a.host || "").localeCompare(b.host || "");
      if (a.cwd !== b.cwd) {
        if (a.cwd === this.cwd) return -1;
        if (b.cwd === this.cwd) return 1;
        return a.cwd.localeCompare(b.cwd);
      }
      return (
        priority[a.status] - priority[b.status] ||
        Number(b.current) - Number(a.current) ||
        b.updated - a.updated ||
        a.key.localeCompare(b.key)
      );
    });
    if (!preserveMissingSelection && this.selectionMissing) {
      this.selectionMissing = false;
      this.notice = "";
    }
    if (this.selectionMissing) return;
    if (!this.visible.some((row) => row.key === this.selected)) {
      if (preserveMissingSelection && this.selected) {
        this.selected = undefined;
        this.selectionMissing = true;
        this.notice = "Selected session left Needs you. Choose another row.";
        return;
      }
      this.selected =
        this.filter === 1
          ? this.visible[0]?.key
          : (this.visible.find((row) => row.current)?.key ??
            this.visible[0]?.key);
      this.scroll = 0;
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.attachAbort) {
      if (this.keys.matches(data, "tui.select.cancel")) {
        this.attachAbort.abort();
        this.form?.handleInput(data);
      }
      return;
    }
    if (this.closeAbort) return;
    if (this.closePrompt) {
      const menu = this.closePrompt.menu;
      if (this.keys.matches(data, "tui.select.cancel")) this.finishClose(false);
      else if (this.keys.matches(data, "tui.select.confirm"))
        this.finishClose(menu.getSelectedItem()?.value === "close");
      else if (
        this.keys.matches(data, "tui.select.up") ||
        this.keys.matches(data, "tui.select.down")
      )
        menu.setSelectedIndex(
          menu.getSelectedItem()?.value === "cancel" ? 1 : 0,
        );
      this.tui.requestRender();
      return;
    }
    if (this.form) {
      this.form.handleInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+x")) {
      this.confirmClose();
      return;
    }
    if (matchesKey(data, "ctrl+n")) {
      this.newAgent();
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.input.getValue()) {
        this.input.setValue("");
        this.refilter();
      } else this.done();
    } else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.filter =
        (this.filter + (matchesKey(data, "tab") ? 1 : filters.length - 1)) %
        filters.length;
      if (this.filter === 1) this.selected = undefined;
      this.notice = "";
      this.refilter();
    } else if (matchesKey(data, "ctrl+p")) {
      this.projectOnly = !this.projectOnly;
      this.refilter();
    } else if (matchesKey(data, "ctrl+o")) {
      this.sourceIndex = (this.sourceIndex + 1) % this.sourceOptions.length;
      this.notice = "";
      this.refilter();
    } else if (matchesKey(data, "ctrl+y")) {
      const row = this.selectedRow();
      const command = row?.nativeCommand;
      if (
        command &&
        (row.host || row.source !== "pi" || row.tmux) &&
        this.copyCommand
      ) {
        void this.copyCommand(command).then(
          () =>
            this.setNotice(
              "Native command copied. Run it in another terminal. Nothing was started here.",
            ),
          () => this.setNotice(`Clipboard unavailable. Command: ${command}`),
        );
      } else
        this.setNotice(
          "No native command for this session. Use its original terminal.",
        );
    } else if (matchesKey(data, "ctrl+r")) {
      this.notice = "";
      this.refresh();
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const row = this.selectedRow();
      if (row) {
        const action = this.enterAction(row);
        if (action === "return") this.done();
        else if (action === "attach") this.openAgent(row.tmux!);
        else if (action === "remote") this.openAgent(row.remoteTmux!);
        else if (action === "resume") this.done(row);
        else if (action === "command")
          this.setNotice(`Ctrl+Y copies: ${row.nativeCommand}`);
        else
          this.setNotice(
            row.source === "pi" && !row.host && row.owners.length
              ? `Live takeover is disabled. Open in another Pi process (PID ${row.owners.map((p) => p.pid).join(", ")}). Use its original terminal.`
              : row.detail || "Use its original terminal.",
          );
      }
    } else {
      let offset = 0;
      if (this.keys.matches(data, "tui.select.up")) offset = -1;
      else if (this.keys.matches(data, "tui.select.down")) offset = 1;
      else if (this.keys.matches(data, "tui.select.pageUp"))
        offset = -this.pageSize;
      else if (this.keys.matches(data, "tui.select.pageDown"))
        offset = this.pageSize;
      if (offset) {
        this.selectionMissing = false;
        const index = this.visible.findIndex(
          (row) => row.key === this.selected,
        );
        this.selected =
          this.visible[
            Math.max(0, Math.min(this.visible.length - 1, index + offset))
          ]?.key;
        this.notice = "";
      } else {
        const before = this.input.getValue();
        this.input.handleInput(data);
        if (this.input.getValue() !== before) this.refilter();
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.renderedWidth = width;
    const height = Math.max(1, this.tui.terminal.rows);
    const w = Math.max(1, Math.min(CONTENT_WIDTH, width - 2));
    const th = this.theme;
    const row = this.selectedRow();
    const attention = this.filter === 1;
    const statusLabel = (agent: AgentRow) =>
      (attention && attentionReasons[agent.status]) || statuses[agent.status];
    const fit = (text: string) => truncateToWidth(text, w);
    const pad = (text: string, columns: number) => {
      const clipped = truncateToWidth(text, Math.max(0, columns));
      return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
    };
    const title =
      th.bold("Agents") +
      th.fg(
        "dim",
        ` · ${this.projectOnly ? "Current local project" : "All projects"} · ${this.sourceOptions[this.sourceIndex] ? sources[this.sourceOptions[this.sourceIndex]!] : "All tools"}`,
      );
    const scoped = filterRows(
      this.rows,
      5,
      "",
      this.projectOnly ? this.cwd : undefined,
      this.sourceOptions[this.sourceIndex],
    );
    const tabs = filters
      .map((label, index) => {
        const text = ` ${label} ${filterRows(scoped, index, "").length} `;
        return index === this.filter
          ? th.bg("selectedBg", th.bold(text))
          : th.fg("dim", text);
      })
      .join(" ");
    const help = th.fg(
      "dim",
      "^N new agent · ^X close pane · ^Y copy · Tab status · ^O tool · ^P project · ^R reload · Esc",
    );
    if (height < 14) {
      return this.frame(
        [
          title,
          th.fg("accent", `${filters[this.filter]} · Tab filter`),
          ...this.input.render(w),
          row
            ? attention
              ? `${statusLabel(row)} · ${row.title}`
              : `[${sourceLabel(row)}] ${row.title} · ${statuses[row.status]}`
            : "No matching sessions",
          ...(attention && row
            ? [th.fg("dim", `[${sourceLabel(row)}] ${projectLabel(row)}`)]
            : []),
          th.fg("dim", this.actionLabel(row)),
          th.fg("dim", row ? connectionLabel(row) : ""),
          this.notice ||
            this.loading ||
            "Enlarge the terminal for project groups and previews.",
          help,
        ].slice(0, height),
        width,
        height,
      );
    }

    const lines = [
      title,
      visibleWidth(tabs) <= w
        ? tabs
        : th.fg(
            "accent",
            `${filters[this.filter]} ${filterRows(scoped, this.filter, "").length} · Tab filter · ${scoped.length} total`,
          ),
      ...this.input.render(w),
      th.fg("border", "─".repeat(w)),
    ];
    const statusWidth = 18;
    const metadata = w >= 56 ? statusWidth + 8 : w >= 36 ? statusWidth : 0;
    const projectWidth = attention && w >= 80 ? 26 : 0;
    const titleWidth = w - metadata - projectWidth;
    lines.push(
      th.fg(
        "dim",
        pad("   Conversation", titleWidth) +
          (projectWidth ? pad("Project", projectWidth) : "") +
          (metadata ? pad(attention ? "Reason" : "Status", statusWidth) : "") +
          (metadata > statusWidth ? pad("Updated", 8) : ""),
      ),
    );

    const items: Array<
      { heading: string } | { agent: AgentRow } | { project: AgentRow }
    > = [];
    let previousProject: string | undefined;
    for (const agent of this.visible) {
      if (!attention && projectKey(agent) !== previousProject) {
        const count = this.visible.filter(
          (candidate) => projectKey(candidate) === projectKey(agent),
        ).length;
        items.push({ heading: `${projectLabel(agent)}  ${count}` });
        previousProject = projectKey(agent);
      }
      items.push({ agent });
      if (attention && !projectWidth) items.push({ project: agent });
    }
    const bodyHeight = Math.max(1, height - 13);
    this.pageSize = Math.max(
      1,
      attention && !projectWidth ? Math.floor(bodyHeight / 2) : bodyHeight - 1,
    );
    const selectedIndex = items.findIndex(
      (item) => "agent" in item && item.agent.key === this.selected,
    );
    const trailingProject =
      attention && !projectWidth && bodyHeight > 1 ? 1 : 0;
    const leadingMargin = attention ? 0 : 1;
    if (selectedIndex >= this.scroll + bodyHeight - trailingProject)
      this.scroll = selectedIndex - bodyHeight + 1 + trailingProject;
    if (selectedIndex >= 0 && selectedIndex < this.scroll + leadingMargin)
      this.scroll = Math.max(0, selectedIndex - leadingMargin);
    this.scroll = Math.min(this.scroll, Math.max(0, items.length - bodyHeight));
    for (let i = 0; i < bodyHeight; i++) {
      const item = items[this.scroll + i];
      if (!item) {
        lines.push(
          i === 0 ? th.fg("dim", this.loading || "No matching sessions") : "",
        );
      } else if ("heading" in item) {
        lines.push(th.fg("dim", fit(item.heading)));
      } else if ("project" in item) {
        lines.push(th.fg("dim", fit(`   ${projectLabel(item.project)}`)));
      } else {
        const agent = item.agent;
        const selected = agent.key === this.selected;
        const marker = selected ? "›" : " ";
        const dot = agent.live ? "●" : "○";
        const name = `${marker}${dot} [${sourceLabel(agent)}] ${agent.current ? "[here] " : ""}${agent.title}`;
        let text = metadata
          ? `${pad(name, titleWidth - 1)} `
          : pad(name, titleWidth);
        if (projectWidth)
          text += `${pad(projectLabel(agent), projectWidth - 1)} `;
        if (metadata) text += pad(statusLabel(agent), statusWidth);
        if (metadata > statusWidth)
          text += pad(agent.updated ? age(agent.updated) : "n/a", 8);
        lines.push(
          selected
            ? th.bg("selectedBg", th.fg("text", text))
            : th.fg(colors[agent.status], text),
        );
      }
    }
    lines.push(th.fg("border", "─".repeat(w)));
    lines.push(
      row
        ? th.bold(
            fit(
              attention
                ? `${statusLabel(row)} · ${row.title}`
                : `${sourceLabel(row)} · ${statuses[row.status]} · ${row.title}`,
            ),
          )
        : "",
    );
    const preview = wrapTextWithAnsi(
      (row?.status === "unknown" && (row.source === "pi" || !row.live)
        ? row.detail || row.preview
        : row?.preview || row?.detail) || "No message preview yet.",
      w,
    ).slice(0, 2);
    if (
      row?.source === "claude" &&
      !row.updated &&
      row.status !== "unknown" &&
      !preview[1]
    )
      preview[1] = "Activity time not provided by Claude.";
    lines.push(
      th.fg("muted", preview[0] || ""),
      th.fg("muted", preview[1] || ""),
    );
    lines.push(
      th.fg("dim", fit(row ? connectionLabel(row) : "")),
      th.fg("dim", fit(this.actionLabel(row))),
    );
    lines.push(
      th.fg(
        this.notice ? "warning" : "dim",
        fit(
          this.notice ||
            this.loading ||
            (attention
              ? `${this.visible.length} shown · Input/approval, errors, stopped · Oldest known activity first`
              : `${this.visible.length} shown · Pi status requires /reload in each Pi instance`),
        ),
      ),
    );
    lines.push(help);
    return this.frame(lines, width, height);
  }

  private frame(lines: string[], width: number, height: number): string[] {
    const margin = width > 2 ? " " : "";
    const contentWidth = Math.max(1, Math.min(CONTENT_WIDTH, width - 2));
    let dialog: string[] | undefined;
    if (this.form) {
      const dialogWidth = Math.min(72, width - 4);
      const innerWidth = dialogWidth - 4;
      const formHeight = 7;
      if (dialogWidth >= 60 && height >= formHeight + 4)
        dialog = this.dialog(
          this.form.render(innerWidth, formHeight),
          dialogWidth,
        );
      else lines = this.form.render(contentWidth, height);
    }
    const result = lines.map((line) => {
      const text = margin + truncateToWidth(line, contentWidth);
      return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
    });
    while (result.length < height) result.push(" ".repeat(Math.max(1, width)));
    let background = result.slice(0, height);
    if (this.form && dialog)
      background = background.map((line) =>
        this.theme.fg("dim", stripTerminalSequences(line)),
      );
    if (this.closePrompt) {
      try {
        dialog = this.renderCloseConfirmation(this.closePrompt);
      } catch {
        dialog = [
          this.theme.bold("Close tmux pane?"),
          this.theme.fg(
            "warning",
            "Enlarge the terminal to review the close confirmation.",
          ),
          this.theme.fg("dim", "Esc cancels"),
        ].map((line) => truncateToWidth(line, Math.max(1, width - 2)));
      }
    }
    if (dialog) {
      const dialogWidth = Math.max(...dialog.map(visibleWidth));
      const top = Math.max(0, Math.floor((height - dialog.length) / 2));
      const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
      for (const [index, line] of dialog.slice(0, height).entries()) {
        background[top + index] = compositeTuiLine(
          background[top + index],
          line,
          left,
          dialogWidth,
          width,
        );
      }
    }
    return background;
  }

  invalidate(): void {
    this.input.invalidate();
    this.form?.invalidate();
    this.closePrompt?.menu.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.launchAbort?.abort();
    this.attachAbort?.abort();
    this.closeAbort?.abort();
    this.closePrompt = undefined;
    this.form?.dispose();
    this.cleanup();
  }
}
