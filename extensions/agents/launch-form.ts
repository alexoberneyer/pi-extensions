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
  isResumeAgent,
  isResumeId,
  localProject,
  validateLaunch,
  type LaunchRequest,
  type ResumeAgent,
} from "./launch.ts";
import { plain, sources } from "./state.ts";

type Field = "Host" | "Agent" | "Mode" | "Session ID" | "Project";
export type ResumeProject = (
  agent: ResumeAgent,
  id: string,
) => string | undefined;
type ResumeOptions = {
  project: ResumeProject;
  loadCatalog?: () => void;
  saved?: { agent: ResumeAgent; id: string; cwd: string };
};

export class LaunchForm implements Component, Focusable {
  private request: LaunchRequest;
  private projects: Record<LaunchRequest["host"], string>;
  private project = new Input({ prompt: "" });
  private originalProject = new Input({
    prompt: "",
    placeholder: "original project directory",
  });
  private sessionId = new Input({
    prompt: "",
    placeholder: "paste full session ID",
  });
  private resuming = false;
  private confirmation?: LaunchRequest;
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
    private resume?: ResumeOptions,
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
    if (resume?.saved) {
      this.request.agent = resume.saved.agent;
      this.resuming = true;
    }
  }

  get height(): number {
    return this.fields.length + (this.confirmation ? 5 : 4);
  }

  private get fields(): Field[] {
    if (this.resume?.saved) return ["Agent", "Session ID", "Project"];
    if (this.canResume)
      return this.resuming
        ? ["Host", "Agent", "Mode", "Session ID", "Project"]
        : ["Host", "Agent", "Mode", "Project"];
    return ["Host", "Agent", "Project"];
  }

  private get canResume(): boolean {
    return Boolean(
      this.resume &&
      this.request.host === "local" &&
      isResumeAgent(this.request.agent),
    );
  }

  private get resumeId(): string {
    return (
      this.resume?.saved?.id ?? this.sessionId.getValue().trim().toLowerCase()
    );
  }

  private get savedProject(): string | undefined {
    if (this.confirmation) return this.confirmation.cwd;
    if (this.resume?.saved) return this.resume.saved.cwd;
    const { agent } = this.request;
    if (this.resuming && isResumeAgent(agent) && isResumeId(this.resumeId))
      return this.resume?.project(agent, this.resumeId);
  }

  private fieldInput(field: Field): Input | undefined {
    if (this.resume?.saved || this.confirmation) return undefined;
    if (field === "Session ID") return this.sessionId;
    if (field === "Project")
      return this.resuming
        ? this.savedProject
          ? undefined
          : this.originalProject
        : this.project;
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    const input = this.fieldInput(this.fields[this.selection]);
    for (const field of [this.project, this.originalProject, this.sessionId])
      field.focused =
        value && field === input && !this.pending && !this.failure;
  }

  private cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  private cycle(direction: number): void {
    if (this.resume?.saved) return;
    this.error = "";
    const field = this.fields[this.selection];
    if (field === "Host") {
      if (!this.remoteEnabled) {
        this.error = "Remote launching is disabled with remote discovery.";
        return;
      }
      this.projects[this.request.host] = this.project.getValue();
      this.request.host = this.request.host === "local" ? "dev01" : "local";
      this.project.setValue(this.projects[this.request.host]);
      this.resuming = false;
    } else if (field === "Agent") {
      this.request.agent =
        agents[
          (agents.indexOf(this.request.agent) + direction + agents.length) %
            agents.length
        ];
      this.resuming = false;
    } else if (field === "Mode") {
      this.resuming = !this.resuming;
      if (this.resuming) this.resume?.loadCatalog?.();
    }
  }

  private launch(): void {
    try {
      if (this.confirmation) {
        const request = { ...this.confirmation, confirmUnverified: true };
        this.confirmation = undefined;
        this.pending = "Checking session…";
        this.done(request);
        return;
      }
      const request = { ...this.request };
      if (this.resuming) {
        if (!isResumeId(this.resumeId))
          throw new Error("Enter the full session ID (UUID).");
        request.resumeId = this.resumeId;
      }
      const value = this.resuming
        ? (this.savedProject ?? this.originalProject.getValue())
        : this.project.getValue();
      if (!value.trim())
        throw new Error(
          this.resuming
            ? "Enter the original project directory."
            : "Project cannot be empty.",
        );
      request.cwd =
        request.host === "local" ? localProject(value, this.cwd) : value;
      validateLaunch(request);
      this.pending = this.resuming ? "Checking session…" : "Launching…";
      this.done(request);
    } catch (error) {
      this.error = plain(String(error));
    }
  }

  reportUnverifiedResume(request: LaunchRequest): void {
    this.pending = "";
    this.confirmation = request;
    this.tui.requestRender();
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
      else if (!this.confirmation && !this.resume?.saved) {
        const fields = this.fields;
        const input = this.fieldInput(fields[this.selection]);
        if (
          matchesKey(data, "tab") ||
          this.keys.matches(data, "tui.select.down")
        )
          this.selection = (this.selection + 1) % fields.length;
        else if (
          matchesKey(data, "shift+tab") ||
          this.keys.matches(data, "tui.select.up")
        )
          this.selection = (this.selection + fields.length - 1) % fields.length;
        else if (input) {
          input.handleInput(data);
          this.error = "";
        } else if (matchesKey(data, "left") || matchesKey(data, "right"))
          this.cycle(matchesKey(data, "left") ? -1 : 1);
      }
    }
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  render(width: number, height = this.tui.terminal.rows): string[] {
    width = Math.max(1, width);
    height = Math.max(1, height);
    this.focused = this.hasFocus;
    const title = this.theme.bold(
      `${this.resuming ? "Resume in tmux" : "New agent"}${this.failure ? (this.reconnect ? " · cannot open" : " · launch failed") : ""}`,
    );
    const footer = this.theme.fg(
      "dim",
      this.failure
        ? this.reconnect
          ? "↑↓ scroll · Enter reconnect · Esc return"
          : "↑↓ scroll · Enter/Esc return · Check agents before retrying"
        : this.pending
          ? "Esc return · A started agent keeps running"
          : this.confirmation
            ? "Enter only if closed elsewhere · Esc cancel"
            : this.resume?.saved
              ? "Enter resume · Esc cancel"
              : `Tab/↑↓ field · ←→ change · Enter ${this.resuming ? "resume" : "launch"} · Esc cancel`,
    );
    const values: Record<Field, string> = {
      Host: `‹ ${this.request.host === "local" ? "This Mac" : "dev01"} ›`,
      Agent: this.resume?.saved
        ? sources[this.request.agent]
        : `‹ ${this.request.agent} ›`,
      Mode: `‹ ${this.resuming ? "Resume" : "New session"} ›`,
      "Session ID": plain(this.resumeId),
      Project: plain(
        this.resuming
          ? (this.savedProject ?? this.originalProject.getValue())
          : this.project.getValue(),
      ),
    };
    const fields = this.fields.map((label, index) => {
      const selected =
        !this.resume?.saved && !this.confirmation && index === this.selection;
      const prefix = truncateToWidth(
        `${selected ? "› " : "  "}${label.padEnd(this.resuming ? 11 : 9)}`,
        Math.max(0, width - 1),
        "",
      );
      const input = this.fieldInput(label);
      if (input?.focused)
        return (
          this.theme.fg("accent", prefix) +
          input.render(Math.max(1, width - prefix.length))[0]
        );
      const line = prefix + values[label];
      return selected ? this.theme.fg("accent", line) : line;
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
          ...(this.confirmation
            ? wrapTextWithAnsi(
                "Could not verify whether this session is already open.",
                width,
              ).map((line) => this.theme.fg("warning", line))
            : [
                this.pending
                  ? this.theme.fg("dim", this.pending)
                  : this.error
                    ? this.theme.fg("warning", this.error)
                    : this.theme.fg(
                        "dim",
                        this.resuming
                          ? "Reopens the same conversation without sending a prompt."
                          : "Uses shared project files.",
                      ),
              ]),
        ];
    const available = Math.max(1, height - 2);
    const start = this.failure
      ? Math.min(this.messageScroll, Math.max(0, body.length - available))
      : this.confirmation
        ? Math.max(0, body.length - available)
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
    this.originalProject.invalidate();
    this.sessionId.invalidate();
  }
  dispose(): void {
    this.closed = true;
  }
}
