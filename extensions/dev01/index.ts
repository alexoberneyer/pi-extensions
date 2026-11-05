import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Resolve the package helper from the real file, including symlinked installs.
const { cleanOutput, listPanes, runJob, transfer, uploadClipboard } =
  await import(
    new URL(
      "../../bin/dev01.mjs",
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
    ).href
  );

export default function dev01Extension(pi: ExtensionAPI) {
  let pending: AbortController | undefined;

  pi.registerMessageRenderer(
    "dev01",
    (message) =>
      new Text(
        typeof message.content === "string" ? message.content : "",
        0,
        0,
      ),
  );
  pi.on("session_shutdown", (_event, ctx) => {
    pending?.abort();
    if (ctx.hasUI) ctx.ui.setStatus("dev01", undefined);
  });

  const commands = {
    devpush: {
      description:
        "Upload the configured shared directory to dev01. Optional -n previews changes.",
      run: (args: string, signal: AbortSignal) =>
        transfer("push", args.trim() ? args.trim().split(/\s+/) : [], signal),
    },
    devpull: {
      description:
        "Download the configured shared directory from dev01. Optional -n previews changes.",
      run: (args: string, signal: AbortSignal) =>
        transfer("pull", args.trim() ? args.trim().split(/\s+/) : [], signal),
    },
    devrun: {
      description:
        "Start a dev01 job: /devrun [--agent pi|claude|codex] <name> <task> (default: claude)",
      run: (args: string, signal: AbortSignal) => runJob(args, signal),
    },
    devclip: {
      description:
        "Upload the Mac clipboard image to dev01 and copy its remote path.",
      run: (args: string, signal: AbortSignal) => {
        if (args.trim()) throw new Error("Usage: /devclip");
        return uploadClipboard(signal);
      },
    },
    devls: {
      description:
        "List dev01 tmux panes and attach commands. /agents shows agent status.",
      run: (args: string, signal: AbortSignal) => {
        if (args.trim()) throw new Error("Usage: /devls");
        return listPanes(signal);
      },
    },
  };

  for (const [name, command] of Object.entries(commands)) {
    pi.registerCommand(name, {
      description: command.description,
      handler: async (args, ctx) => {
        if (pending) {
          ctx.ui.notify("A dev01 operation is already running.", "warning");
          return;
        }
        const controller = new AbortController();
        pending = controller;
        if (ctx.hasUI) ctx.ui.setStatus("dev01", `${name} · dev01`);
        try {
          const output = await command.run(args, controller.signal);
          if (controller.signal.aborted) return;
          const text = cleanOutput(output);
          pi.sendMessage(
            {
              customType: "dev01",
              content: `${name} · dev01\n${text.slice(0, 16_000)}${text.length > 16_000 ? "\nOutput truncated. Run the terminal command for full output." : ""}`,
              display: true,
            },
            { triggerTurn: false },
          );
        } catch (error) {
          if (!controller.signal.aborted)
            ctx.ui.notify(cleanOutput(String(error)), "error");
        } finally {
          pending = undefined;
          if (ctx.hasUI && !controller.signal.aborted)
            ctx.ui.setStatus("dev01", undefined);
        }
      },
    });
  }
}
