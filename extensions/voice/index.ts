import {
  type CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  parseKey,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { readConfig } from "../../lib/config.mjs";
import { launchWorker } from "./client.mjs";
import { VoiceController } from "./controller.mjs";
import { VoiceKeys } from "./keys.mjs";

const WIDGET = "local-voice";
const voiceControl = (text: string) =>
  /^\/voice(?::[0-9]+)?(?:\s|$)/i.test(text.trimStart());
type PromptEditor = CustomEditor & { readonly acceptsLiteralSpace?: boolean };
type Target = { editor: PromptEditor; text: string };

export function installVoice(
  pi: ExtensionAPI,
  {
    createWorker = launchWorker,
    supported = () =>
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      !process.env.SSH_CONNECTION &&
      !process.env.SSH_TTY,
  } = {},
) {
  const config = readConfig().voice;
  let ctx: ExtensionContext | undefined;
  let tui: TUI | undefined;
  let editor: PromptEditor | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoreSubmit: (() => void) | undefined;
  let space = config.space;
  let reporting = false;
  let reportingDirty = true;
  let reportingTimer: ReturnType<typeof setTimeout> | undefined;

  const atMain = () => Boolean(editor && tui?.getFocusedComponent() === editor);
  const releaseSupported = () => Boolean(tui?.terminal.kittyProtocolActive);
  const target = (): Target | undefined =>
    atMain() && ctx && editor
      ? { editor, text: ctx.ui.getEditorText() }
      : undefined;
  const spaceAllowed = () => {
    if (!atMain() || !editor || editor.isShowingAutocomplete()) return false;
    if (typeof editor.acceptsLiteralSpace === "boolean")
      return editor.acceptsLiteralSpace;
    // Only the stock editor is known to be non-modal. A guarded check preserves
    // its native find-character prompt, for which Space is a valid target.
    return (
      !ctx?.ui.getEditorComponent() &&
      (editor as unknown as { jumpMode?: unknown }).jumpMode === null
    );
  };

  function keyboardReporting(enable: boolean) {
    if (!tui) return;
    if (!enable || !space) {
      clearTimeout(reportingTimer);
      reportingTimer = undefined;
    } else if (!releaseSupported() && reportingDirty && !reportingTimer) {
      // Pi consumes Kitty negotiation replies without a render notification.
      // A bounded retry catches resume negotiation without a permanent poller.
      let attempts = 0;
      const retry = () => {
        reportingTimer = undefined;
        if (!controller.enabled || !space) return;
        if (releaseSupported()) {
          keyboardReporting(true);
          tui?.requestRender();
        } else if (++attempts < 40) reportingTimer = setTimeout(retry, 25);
        else reportingDirty = false;
      };
      reportingTimer = setTimeout(retry, 25);
    }
    const wanted = enable && space && releaseSupported();
    if (wanted && (!reporting || reportingDirty)) {
      // Add only report-all-keys to Pi's current Kitty stack frame. Never push
      // another frame, which would leak Pi's own frame on suspend/renderer stop.
      tui.terminal.write("\x1b[=8;2u");
      reporting = true;
      reportingDirty = false;
    } else if (!wanted && reporting) {
      if (releaseSupported()) tui.terminal.write("\x1b[=8;3u");
      reporting = false;
    }
  }

  const controller = new VoiceController({
    createWorker: (callbacks) =>
      createWorker({ ...callbacks, device: config.device }),
    onChange: () => render(),
    onNotice: (message, level) => ctx?.ui.notify(message, level),
    onFinal: (text: string, destination: Target | undefined, { explicit }) => {
      if (!ctx || !atMain() || destination?.editor !== editor) return false;
      if (!explicit && ctx.ui.getEditorText() !== destination.text)
        return false;
      ctx.ui.pasteToEditor(text);
      return true;
    },
  });
  const keys = new VoiceKeys({
    shortcut: config.shortcut,
    cancelShortcut: config.cancelShortcut,
    mode: config.mode,
    getContext: () => ({
      enabled: controller.enabled,
      atMain: atMain(),
      releaseSupported: releaseSupported(),
      spaceEnabled: space,
      spaceAllowed: spaceAllowed(),
      ready: controller.state === "ready",
      pending: controller.state === "pending",
      active: ["starting", "recording"].includes(controller.state),
    }),
    onStart: () => controller.start(target()),
    onStop: () => controller.stop(),
    onCancel: () => controller.cancel(),
    // This is an ordinary delayed Space tap, not transcript delivery. Keep its
    // native typing/undo semantics rather than inserting it as a paste.
    onTapSpace: () => {
      editor?.handleInput(" ");
      tui?.requestRender();
    },
  });

  function widget() {
    ctx!.ui.setWidget(WIDGET, (surface, theme) => {
      tui = surface;
      return {
        render(width) {
          keyboardReporting(controller.enabled);
          const gesture =
            config.mode === "hold" && releaseSupported() ? "hold" : "toggle";
          const hint =
            controller.state === "pending"
              ? `${config.shortcut} insert · ${config.cancelShortcut} discard`
              : `${gesture} ${config.shortcut}${space && releaseSupported() ? " or Space in INSERT" : ""} · ${config.cancelShortcut} discard`;
          const label =
            controller.state === "recording" ? "● recording" : controller.state;
          const lines = wrapTextWithAnsi(
            theme.fg(
              controller.state === "recording" ? "warning" : "muted",
              `voice · ${label} · ${hint}`,
            ),
            width,
          );
          if (controller.preview)
            lines.push(
              ...wrapTextWithAnsi(
                theme.fg("accent", controller.preview),
                width,
              ).slice(-3),
            );
          return lines;
        },
        invalidate() {
          reportingDirty = true;
        },
      };
    });
  }

  function render() {
    if (!ctx) return;
    if (controller.enabled) widget();
    else {
      keys.reset();
      keyboardReporting(false);
      unsubscribe?.();
      unsubscribe = undefined;
      restoreSubmit?.();
      restoreSubmit = undefined;
      ctx.ui.setWidget(WIDGET, undefined);
    }
  }

  function activate(context: ExtensionContext) {
    if (controller.enabled) return true;
    if (context.mode !== "tui" || !supported()) {
      context.ui.notify(
        "Local voice requires interactive Pi on an Apple silicon Mac, outside SSH.",
        "warning",
      );
      return false;
    }
    const bindings = getKeybindings().getResolvedBindings();
    const collision = Object.entries(bindings).find(
      ([, values]) =>
        values.includes(config.shortcut) ||
        values.includes(config.cancelShortcut),
    );
    if (collision) {
      context.ui.notify(
        `Voice shortcut conflicts with ${collision[0]}. Change voice shortcuts and reload.`,
        "error",
      );
      return false;
    }
    ctx = context;
    widget();
    const focused = tui?.getFocusedComponent() as PromptEditor | undefined;
    // Pi wires onExtensionShortcut on the main prompt, not on dialog editors.
    if (
      !focused ||
      typeof focused.onExtensionShortcut !== "function" ||
      typeof focused.getCursor !== "function"
    ) {
      context.ui.setWidget(WIDGET, undefined);
      context.ui.notify(
        "Enable voice from Pi's main prompt, not a dialog.",
        "warning",
      );
      return false;
    }
    editor = focused;
    const previousSubmit = focused.onSubmit;
    const submit: typeof previousSubmit = (text) => {
      // Built-in and extension commands skip Pi's input event. Retire the id at
      // the actual submission boundary, except explicit voice control commands.
      if (!voiceControl(text)) {
        keys.reset();
        controller.cancel();
      }
      return previousSubmit?.(text);
    };
    focused.onSubmit = submit;
    restoreSubmit = () => {
      if (focused.onSubmit === submit) focused.onSubmit = previousSubmit;
    };
    let pasting = false;
    unsubscribe = context.ui.onTerminalInput((data) => {
      if (pasting || data.includes("\x1b[200~")) {
        keys.flushTap();
        pasting = !data.includes("\x1b[201~");
        return;
      }
      const release = isKeyRelease(data);
      const bindings = getKeybindings();
      if (
        !release &&
        atMain() &&
        bindings.matches(data, "app.message.followUp") &&
        context.ui.getEditorText().trim() &&
        !voiceControl(context.ui.getEditorText())
      ) {
        // While streaming, follow-up bypasses the editor's onSubmit callback.
        keys.reset();
        controller.cancel();
      }
      // A detached capture must not continue while Pi is suspended or hands its
      // terminal to an external editor. Respect remapped application bindings.
      if (
        !release &&
        ["app.suspend", "app.editor.external"].some((action) =>
          getKeybindings().matches(
            data,
            action as "app.suspend" | "app.editor.external",
          ),
        )
      ) {
        keys.reset();
        controller.cancel();
        keyboardReporting(false);
        reportingDirty = true;
      }
      return keys.handle({
        key: parseKey(data),
        release,
        repeat: isKeyRepeat(data),
        encoded: data.startsWith("\x1b["),
        text: !data.startsWith("\x1b") && /[^\x00-\x1f\x7f]/.test(data),
      });
    });
    controller.enable();
    if (!controller.enabled) render();
    return controller.enabled;
  }

  pi.registerShortcut(config.shortcut, {
    description:
      "Enable local voice, then hold/toggle recording or insert pending text",
    handler: async (context) => {
      if (!controller.enabled) activate(context);
    },
  });
  pi.registerShortcut(config.cancelShortcut, {
    description:
      "Discard local dictation without changing Vim or Pi's Escape behavior",
    handler: async () => controller.cancel(),
  });
  pi.registerCommand("voice", {
    description:
      "Local dictation: on, off, start, stop, cancel, insert, status, space on/off",
    getArgumentCompletions(prefix) {
      return [
        "on",
        "off",
        "start",
        "stop",
        "cancel",
        "insert",
        "status",
        "space on",
        "space off",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, context) => {
      const command = args.trim().toLowerCase();
      if (!command || command === "on") {
        if (!command && controller.enabled) await controller.disable();
        else activate(context);
      } else if (command === "off") await controller.disable();
      else if (command === "cancel") controller.cancel();
      else if (command === "stop") controller.stop();
      else if (command === "start") {
        if (controller.enabled && atMain()) controller.start(target());
        else activate(context);
      } else if (command === "insert") controller.insertPending(target());
      else if (command === "status")
        context.ui.notify(
          `Voice ${controller.state}. Microphone capture starts only on a recording gesture or /voice start.`,
          "info",
        );
      else if (command === "space on" || command === "space off") {
        space = command === "space on";
        keyboardReporting(controller.enabled);
        render();
        context.ui.notify(
          `Hold-Space ${space ? "enabled" : "disabled"}. ${releaseSupported() ? "Only literal Space in INSERT is intercepted." : "Requires a terminal with Kitty key-release reporting."}`,
          "info",
        );
      } else
        context.ui.notify(
          "Use /voice on, off, start, stop, cancel, insert, status or space on/off.",
          "warning",
        );
    },
  });
  pi.on("session_shutdown", async () => {
    await controller.disable();
    ctx = undefined;
    tui = undefined;
    editor = undefined;
  });
  return controller;
}

export default function (pi: ExtensionAPI) {
  installVoice(pi);
}
