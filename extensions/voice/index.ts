import { stripVTControlCharacters } from "node:util";
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
import {
  getVoiceWorkerSafety,
  IDLE_MS,
  VoiceController,
} from "./controller.mjs";
import { VoiceKeys } from "./keys.mjs";
import { createVoicePreferences } from "./preferences.mjs";

const WIDGET = "local-voice";
const voiceControl = (text: string) =>
  /^\/voice(?::[0-9]+)?(?:\s|$)/i.test(text.trimStart());
type PromptEditor = CustomEditor & { readonly acceptsLiteralSpace?: boolean };
type Target = { editor: PromptEditor; text: string };

// AVFoundation's default can differ from the first device FFmpeg lists.
const DEFAULT_MIC_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("AVFoundation");
const device = $.NSClassFromString("AVCaptureDevice").defaultDeviceWithMediaType($.AVMediaTypeAudio);
device.isNil() ? "" : ObjC.unwrap(device.localizedName);
`;

async function resolveMicrophone(pi: ExtensionAPI, device: string) {
  const options = { timeout: 2500, maxBuffer: 32 * 1024 };
  let name: string | undefined;
  try {
    if (device === ":default") {
      const result = await pi.exec(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", DEFAULT_MIC_SCRIPT],
        options,
      );
      if (!result.killed && !result.truncated && result.code === 0)
        name = result.stdout;
    } else {
      // Listing exits before opening a capture device and normally returns nonzero.
      const result = await pi.exec(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-f",
          "avfoundation",
          "-list_devices",
          "true",
          "-i",
          "",
        ],
        options,
      );
      if (result.killed || result.truncated) return;
      const lines = result.stderr.split(/\r?\n/);
      const header = " AVFoundation audio devices:";
      const start = lines.findIndex((line) => line.endsWith(header));
      if (start === -1) return;
      const prefix = `${lines[start].slice(0, -header.length)} `;
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith(prefix)) continue;
        const entry = /^\[(\d+)\] (.+)$/.exec(line.slice(prefix.length));
        if (entry && Number(entry[1]) === Number(device.slice(1))) {
          name = entry[2];
          break;
        }
      }
    }
  } catch {
    // The lookup is best effort. Never surface raw process diagnostics in Pi.
  }
  return (
    name &&
    stripVTControlCharacters(name)
      .replace(/\p{Cc}/gu, " ")
      .trim()
  );
}

export function installVoice(
  pi: ExtensionAPI,
  {
    createWorker = launchWorker,
    preferences = createVoicePreferences(),
    idleMs = IDLE_MS,
    safety = getVoiceWorkerSafety(),
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
      // Pi consumes Kitty replies without a render notification on resume.
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
      // Modify Pi's current frame, never push a frame that could leak on suspend.
      tui.terminal.write("\x1b[=8;2u");
      reporting = true;
      reportingDirty = false;
    } else if (!wanted && reporting) {
      if (releaseSupported()) tui.terminal.write("\x1b[=8;3u");
      reporting = false;
    }
  }

  const controller = new VoiceController({
    idleMs,
    safety,
    createWorker: (callbacks) =>
      createWorker({ ...callbacks, device: config.device }),
    canStart: (destination: Target | undefined) =>
      atMain() && destination?.editor === editor,
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
    mode: config.mode,
    getContext: () => ({
      enabled: controller.enabled,
      atMain: atMain(),
      releaseSupported: releaseSupported(),
      spaceEnabled: space,
      spaceAllowed: spaceAllowed(),
      ready:
        ["ready", "standby", "loading"].includes(controller.state) &&
        !controller.recordingRequested,
      pending: controller.state === "pending",
      active:
        controller.recordingRequested &&
        ["loading", "starting", "recording"].includes(controller.state),
    }),
    onStart: () => controller.start(target()),
    onStop: () => controller.stop(),
    onTapSpace: () => {
      editor?.handleInput(" ");
      tui?.requestRender();
    },
  });

  function refreshEditor() {
    const focused = tui?.getFocusedComponent() as PromptEditor | undefined;
    // Only the main prompt receives Pi's extension-shortcut callback.
    if (
      !focused ||
      typeof focused.onExtensionShortcut !== "function" ||
      typeof focused.getCursor !== "function"
    )
      return false;
    if (editor === focused) return true;
    restoreSubmit?.();
    editor = focused;
    const previousSubmit = focused.onSubmit;
    const submit: typeof previousSubmit = (text) => {
      // Command dispatch bypasses Pi's input event, so guard the real boundary.
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
    return true;
  }

  function widget() {
    ctx!.ui.setWidget(WIDGET, (surface, theme) => {
      tui = surface;
      return {
        render(width) {
          // On reload without Vim, Pi may focus its reload panel until all
          // session_start handlers finish. Attach when the real prompt returns.
          refreshEditor();
          keyboardReporting(controller.enabled);
          const gesture =
            config.mode === "hold" && releaseSupported() ? "hold" : "toggle";
          const hint =
            controller.state === "pending"
              ? `${config.shortcut} insert`
              : controller.state === "loading" && controller.recordingRequested
                ? "wait before speaking"
                : `${gesture} ${config.shortcut}${space && releaseSupported() ? " or Space in INSERT" : ""}`;
          const seconds = controller.countdownSeconds;
          const detail = seconds === undefined ? hint : `${seconds}s left`;
          const label =
            controller.state === "recording" ? "● recording" : controller.state;
          const lines = wrapTextWithAnsi(
            theme.fg(
              controller.state === "recording" ? "warning" : "muted",
              `voice · ${label} · ${detail}`,
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

  function disconnect() {
    keys.reset();
    keyboardReporting(false);
    unsubscribe?.();
    unsubscribe = undefined;
    restoreSubmit?.();
    restoreSubmit = undefined;
    editor = undefined;
    ctx?.ui.setWidget(WIDGET, undefined);
  }

  function render() {
    if (!ctx) return;
    if (controller.enabled) widget();
    else disconnect();
  }

  function cancelDictation() {
    keys.reset();
    controller.cancel();
  }

  function connect(context: ExtensionContext, deferred = false) {
    if (context.mode !== "tui" || !supported()) {
      if (!deferred)
        context.ui.notify(
          "Local voice requires interactive Pi on an Apple silicon Mac, outside SSH.",
          "warning",
        );
      return false;
    }
    if (controller.enabled) {
      ctx = context;
      refreshEditor();
      return true;
    }
    const collision = Object.entries(
      getKeybindings().getResolvedBindings(),
    ).find(([, value]) =>
      (Array.isArray(value) ? value : [value]).includes(config.shortcut),
    );
    if (collision) {
      context.ui.notify(
        `Voice shortcut conflicts with ${collision[0]}. Change voice shortcuts and restart.`,
        "error",
      );
      return false;
    }
    ctx = context;
    widget();
    if (!refreshEditor() && !deferred) {
      disconnect();
      context.ui.notify(
        "Enable voice from Pi's main prompt, not a dialog.",
        "warning",
      );
      return false;
    }
    let pasting = false;
    unsubscribe = context.ui.onTerminalInput((data) => {
      refreshEditor();
      if (pasting || data.includes("\x1b[200~")) {
        keys.flushTap();
        pasting = !data.includes("\x1b[201~");
        return;
      }
      const release = isKeyRelease(data);
      const bindings = getKeybindings();
      if (!release && bindings.matches(data, "app.clear")) {
        // Still let Pi handle clearing and double-Ctrl+C exit. Escape is not
        // intercepted. Retire speech before native clearing can change drafts.
        cancelDictation();
      }
      if (
        !release &&
        atMain() &&
        bindings.matches(data, "app.message.followUp") &&
        context.ui.getEditorText().trim() &&
        !voiceControl(context.ui.getEditorText())
      )
        cancelDictation();
      if (
        !release &&
        ["app.suspend", "app.editor.external"].some((action) =>
          bindings.matches(
            data,
            action as "app.suspend" | "app.editor.external",
          ),
        )
      ) {
        cancelDictation();
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
    return true;
  }

  function enableFromUser(context: ExtensionContext) {
    if (!connect(context)) return;
    try {
      preferences.write(true);
    } catch {
      context.ui.notify(
        "Cannot save Voice preference. Voice was not enabled persistently.",
        "error",
      );
      if (!controller.enabled) disconnect();
      return;
    }
    controller.enable();
    if (!controller.enabled) render();
  }

  async function disableFromUser(context: ExtensionContext) {
    const closing = controller.disable();
    try {
      preferences.write(false);
    } catch {
      context.ui.notify(
        "Cannot save Voice preference. Voice is off here, but future sessions may still enable it.",
        "error",
      );
    }
    await closing;
  }

  pi.registerShortcut(config.shortcut, {
    description:
      "Enable local voice, hold/toggle recording or insert pending text",
    handler: async (context) => {
      if (!controller.enabled) enableFromUser(context);
    },
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
        if (!command && controller.enabled) await disableFromUser(context);
        else enableFromUser(context);
      } else if (command === "off") await disableFromUser(context);
      else if (command === "cancel") cancelDictation();
      else if (command === "stop") controller.stop();
      else if (command === "start") {
        refreshEditor();
        if (controller.enabled && atMain()) controller.start(target());
        else if (!controller.enabled) enableFromUser(context);
      } else if (command === "insert") {
        refreshEditor();
        controller.insertPending(target());
      } else if (command === "status") {
        const device = config.device;
        const selection = device === ":default" ? "system default" : device;
        const name =
          context.mode === "tui" && supported()
            ? await resolveMicrophone(pi, device)
            : undefined;
        const state = controller.state;
        const hint = ["standby", "loading", "starting"].includes(state)
          ? " Wait for recording before speaking."
          : "";
        context.ui.notify(
          `Voice ${state}. Next input: ${name || "unavailable"} (${selection}).${hint}`,
          "info",
        );
      } else if (command === "space on" || command === "space off") {
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
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui" || !supported() || controller.enabled) return;
    try {
      if (preferences.read() && connect(context, true)) {
        controller.enable({ warm: false });
        if (!controller.enabled) render();
      }
    } catch {
      context.ui.notify(
        "Cannot read saved Voice preference. Voice remains off.",
        "error",
      );
    }
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
