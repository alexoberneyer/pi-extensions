import { randomUUID } from "node:crypto";
import { readConfig } from "../../lib/config.mjs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  agents,
  localProject,
  validateLaunch,
  type LaunchRequest,
} from "./launch.ts";
import { plain } from "./state.ts";

export class LaunchForm implements Component, Focusable {
  private request: LaunchRequest;
  private projects: Record<LaunchRequest["host"], string>;
  private project = new Input({ prompt: "" });
  private selection = 0;
  private error = "";
  private hasFocus = false;
  private pending = "";
  private closed = false;
  private failure = "";
  private reconnect?: () => void;
  private messageScroll = 0;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private cwd: string,
    private remoteEnabled: boolean,
    private done: (request?: LaunchRequest) => void,
  ) {
    const remote = readConfig().remote;
    this.remoteEnabled = remoteEnabled && Boolean(remote.host);
    this.projects = { local: cwd, dev01: remote.project };
    this.request = {
      host: "local",
      agent: "pi",
      cwd,
      name: `job-${randomUUID().slice(0, 8)}`,
    };
    this.project.setValue(cwd);
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.project.focused =
      value && this.selection === 2 && !this.pending && !this.failure;
  }

  private cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  private cycle(direction: number): void {
    this.error = "";
    if (this.selection === 0) {
      if (!this.remoteEnabled) {
        this.error = "Remote launching is disabled with remote discovery.";
        return;
      }
      this.projects[this.request.host] = this.project.getValue();
      this.request.host = this.request.host === "local" ? "dev01" : "local";
      this.project.setValue(this.projects[this.request.host]);
    } else if (this.selection === 1) {
      this.request.agent =
        agents[
          (agents.indexOf(this.request.agent) + direction + agents.length) %
            agents.length
        ];
    }
  }

  private launch(): void {
    try {
      const value = this.project.getValue();
      if (!value.trim()) throw new Error("Project cannot be empty.");
      this.request.cwd =
        this.request.host === "local" ? localProject(value, this.cwd) : value;
      validateLaunch(this.request);
      this.pending = "Launching…";
      this.done({ ...this.request });
    } catch (error) {
      this.error = plain(String(error));
    }
  }

  reportFailure(message: string): void {
    this.pending = "";
    this.failure = plain(message, 3_000);
    this.messageScroll = 0;
    this.tui.requestRender();
  }

  reportOpening(): void {
    this.failure = "";
    this.pending = "Opening agent…";
    this.tui.requestRender();
  }

  reportOpenFailure(message: string, reconnect: () => void): void {
    this.reconnect = reconnect;
    this.reportFailure(message);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keys.matches(data, "tui.select.cancel")) this.cancel();
    else if (this.failure) {
      if (this.keys.matches(data, "tui.select.confirm")) {
        if (this.reconnect) {
          this.reportOpening();
          this.reconnect();
        } else this.cancel();
      } else if (this.keys.matches(data, "tui.select.up"))
        this.messageScroll = Math.max(0, this.messageScroll - 1);
      else if (this.keys.matches(data, "tui.select.down")) this.messageScroll++;
    } else if (!this.pending) {
      if (this.keys.matches(data, "tui.select.confirm")) this.launch();
      else if (
        matchesKey(data, "tab") ||
        this.keys.matches(data, "tui.select.down")
      )
        this.selection = (this.selection + 1) % 3;
      else if (
        matchesKey(data, "shift+tab") ||
        this.keys.matches(data, "tui.select.up")
      )
        this.selection = (this.selection + 2) % 3;
      else if (this.selection === 2) {
        this.project.handleInput(data);
        this.error = "";
      } else if (matchesKey(data, "left") || matchesKey(data, "right"))
        this.cycle(matchesKey(data, "left") ? -1 : 1);
    }
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  render(width: number, height = this.tui.terminal.rows): string[] {
    width = Math.max(1, width);
    height = Math.max(1, height);
    this.focused = this.hasFocus;
    const title = this.theme.bold(
      `New agent${this.failure ? (this.reconnect ? " · cannot open" : " · launch failed") : ""}`,
    );
    const footer = this.theme.fg(
      "dim",
      this.failure
        ? this.reconnect
          ? "↑↓ scroll · Enter reconnect · Esc return"
          : "↑↓ scroll · Enter/Esc return · Check agents before retrying"
        : this.pending
          ? "Esc return · A started agent keeps running"
          : "Tab/↑↓ field · ←→ change · Enter launch · Esc cancel",
    );
    const fields = [
      ["Host", `‹ ${this.request.host === "local" ? "This Mac" : "dev01"} ›`],
      ["Agent", `‹ ${this.request.agent} ›`],
      ["Project", plain(this.project.getValue())],
    ].map(([label, value], index) => {
      const prefix = truncateToWidth(
        `${index === this.selection ? "› " : "  "}${label.padEnd(9)}`,
        Math.max(0, width - 1),
        "",
      );
      if (index === 2 && this.project.focused)
        return (
          this.theme.fg("accent", prefix) +
          this.project.render(Math.max(1, width - prefix.length))[0]
        );
      const line = prefix + value;
      return index === this.selection ? this.theme.fg("accent", line) : line;
    });
    const body = this.failure
      ? [
          ...fields,
          "",
          ...wrapTextWithAnsi(this.failure, width).map((line) =>
            this.theme.fg("warning", line),
          ),
        ]
      : [
          ...fields,
          "",
          this.pending
            ? this.theme.fg("dim", this.pending)
            : this.error
              ? this.theme.fg("warning", this.error)
              : this.theme.fg("dim", "Uses shared project files."),
        ];
    const available = Math.max(1, height - 2);
    const start = this.failure
      ? Math.min(this.messageScroll, Math.max(0, body.length - available))
      : Math.max(0, this.selection - available + 1);
    if (this.failure) this.messageScroll = start;
    const visibleBody = body.slice(start, start + available);
    while (visibleBody.length < available) visibleBody.push("");
    return [title, ...visibleBody, footer]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.project.invalidate();
  }
  dispose(): void {
    this.closed = true;
  }
}
