import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const directory = dirname(fileURLToPath(import.meta.url));
const lineLimit = 64 * 1024;
const textLimit = 16 * 1024;
const protocolError =
  "Voice worker sent invalid data. Disable voice and retry.";
const startupError =
  "Voice worker could not start offline. Cache Python 3.10 and mlx-audio==0.5.3, then retry.";
const workerErrors = new Map([
  [
    "Could not load local speech model. Requires macOS arm64 and mlx-audio==0.5.3.",
    "Local speech model unavailable. Cache the Parakeet model and use macOS arm64.",
  ],
  [
    "ffmpeg is missing. Install ffmpeg to use local voice input.",
    "ffmpeg is missing. Install ffmpeg to use local voice input.",
  ],
  [
    "Microphone unavailable or interrupted. Check macOS microphone permission and --device.",
    "Microphone unavailable. Check microphone permission and the configured device.",
  ],
  [
    "Microphone capture timed out. Check microphone permission and --device.",
    "Microphone timed out. Check microphone permission and the configured device.",
  ],
  [
    "Speech decoding failed. Try again with a shorter recording.",
    "Speech decoding failed. Try again with a shorter recording.",
  ],
]);

function validId(id) {
  return Number.isSafeInteger(id) && id >= 0;
}

function onlyKeys(event, keys) {
  return Object.keys(event).every((key) => keys.includes(key));
}

function cleanText(text) {
  return stripVTControlCharacters(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

function parseEvent(line, decoder) {
  const event = JSON.parse(decoder.decode(line));
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  if (event.type === "ready" && onlyKeys(event, ["type"]))
    return { type: "ready" };
  if (
    ["recording", "cancelled"].includes(event.type) &&
    validId(event.id) &&
    onlyKeys(event, ["type", "id"])
  )
    return { type: event.type, id: event.id };
  if (
    ["partial", "final"].includes(event.type) &&
    validId(event.id) &&
    typeof event.text === "string" &&
    Buffer.byteLength(event.text) <= textLimit &&
    onlyKeys(event, ["type", "id", "text"])
  )
    return { type: event.type, id: event.id, text: cleanText(event.text) };
  if (
    event.type === "error" &&
    (event.id === undefined || validId(event.id)) &&
    typeof event.message === "string" &&
    Buffer.byteLength(event.message) <= textLimit &&
    onlyKeys(event, ["type", "id", "message"])
  )
    return {
      type: "error",
      ...(event.id === undefined ? {} : { id: event.id }),
      message:
        workerErrors.get(event.message) ||
        "Voice worker failed. Disable voice and retry.",
    };
}

/** Start the offline worker explicitly. Importing this module opens nothing. */
export function launchWorker({ device = ":default", onEvent, onError } = {}) {
  let child;
  let pid;
  let ready = false;
  let closing = false;
  let notified = false;
  let trackingIds = false;
  let activeId;
  let reaped = false;
  let buffer = Buffer.alloc(0);
  let startupTimer;
  let closePromise;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function fail(message) {
    if (closing || notified) return;
    notified = true;
    void close().catch(() => {});
    try {
      onError?.(message);
    } catch {
      // A consumer callback must not turn a stream error into an uncaught error.
    }
  }

  function groupExists() {
    if (!pid) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }

  function signalGroup(signal) {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(startupTimer);
    buffer = Buffer.alloc(0);
    let finish;
    let reject;
    closePromise = new Promise((done, failed) => {
      finish = done;
      reject = failed;
    });
    // Install the promise before end(): fake or broken streams can fail inline.
    try {
      child?.stdin?.end('{"type":"shutdown"}\n', () => {});
    } catch {
      // A closed stdin cannot prevent process-group cleanup.
    }
    let timer;
    let polls = 0;
    function complete(error) {
      clearTimeout(timer);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      if (error)
        reject(
          new Error("Voice worker did not stop. Restart Pi before retrying."),
        );
      else finish();
    }
    function check() {
      try {
        if (!groupExists() && reaped) return complete();
        if (++polls >= 60) return complete(true);
        timer = setTimeout(check, 25);
      } catch {
        complete(true);
      }
    }
    function kill() {
      try {
        // Do this even if uv already exited: Python/ffmpeg may still own the PGID.
        signalGroup("SIGKILL");
        check();
      } catch {
        complete(true);
      }
    }
    function terminate() {
      try {
        if (!groupExists() && reaped) return complete();
        signalGroup("SIGTERM");
        timer = setTimeout(kill, 500);
      } catch {
        // Still attempt SIGKILL if the graceful signal could not be delivered.
        kill();
      }
    }
    timer = setTimeout(terminate, 150);
    return closePromise;
  }

  function receive(chunk) {
    if (closing) return;
    try {
      let offset = 0;
      while (offset < chunk.length && !closing) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (buffer.length + end - offset > lineLimit)
          return fail(protocolError);
        const fragment = chunk.subarray(offset, end);
        if (fragment.length)
          buffer = buffer.length
            ? Buffer.concat([buffer, fragment])
            : Buffer.from(fragment);
        if (newline < 0) return;
        const line = buffer;
        buffer = Buffer.alloc(0);
        offset = newline + 1;
        const event = parseEvent(line, decoder);
        if (!event) return fail(protocolError);
        // Cancellation retires an id before Python can finish an in-flight decode.
        if (trackingIds && event.id !== undefined && event.id !== activeId)
          continue;
        if (event.type === "final" || event.type === "cancelled")
          activeId = undefined;
        if (event.type === "ready") {
          ready = true;
          clearTimeout(startupTimer);
        }
        if (event.type === "error") {
          // Closing before notification also ignores trailing output in this chunk.
          notified = true;
          void close().catch(() => {});
        }
        onEvent?.(event);
      }
    } catch {
      fail(protocolError);
    }
  }

  function send(event) {
    if (closing) return false;
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      !(
        (event.type === "shutdown" && onlyKeys(event, ["type"])) ||
        (["start", "stop", "cancel"].includes(event.type) &&
          validId(event.id) &&
          onlyKeys(event, ["type", "id"]))
      )
    ) {
      fail(protocolError);
      return false;
    }
    if (event.type === "start") {
      trackingIds = true;
      activeId = event.id;
    } else if (event.type === "cancel" && event.id === activeId) {
      activeId = undefined;
    }
    try {
      child.stdin.write(`${JSON.stringify(event)}\n`, (error) => {
        if (error) fail("Voice worker input closed. Disable voice and retry.");
      });
      return true;
    } catch {
      fail("Voice worker input closed. Disable voice and retry.");
      return false;
    }
  }

  try {
    if (process.platform === "win32") throw new Error("Unsupported platform");
    child = spawn(
      "uv",
      [
        "run",
        "--no-project",
        "--offline",
        "--python",
        "3.10",
        "--with",
        "mlx-audio==0.5.3",
        "python",
        "-u",
        resolve(directory, "worker.py"),
        "--device",
        device,
        "--max-seconds",
        "60",
      ],
      {
        cwd: resolve(directory, "../.."),
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
          PYTHONUNBUFFERED: "1",
        },
      },
    );
    // Only a freshly detached child's PGID is ever signalled, never our group.
    if (
      Number.isSafeInteger(child.pid) &&
      child.pid > 1 &&
      child.pid !== process.pid
    )
      pid = child.pid;
    child.on("error", (error) => {
      if (!pid) reaped = true;
      fail(
        error.code === "ENOENT"
          ? "uv is missing. Install uv and cache the offline voice dependencies."
          : startupError,
      );
    });
    child.on("exit", () => {
      reaped = true;
      fail(
        ready
          ? "Voice worker stopped unexpectedly. Disable voice and retry."
          : startupError,
      );
    });
    child.on("close", () => {
      reaped = true;
      if (!closing)
        fail(
          ready
            ? "Voice worker stopped unexpectedly. Disable voice and retry."
            : startupError,
        );
    });
    child.stdin.on("error", () =>
      fail("Voice worker input closed. Disable voice and retry."),
    );
    child.stdout.on("error", () => fail(protocolError));
    child.stdout.on("data", receive);
    startupTimer = setTimeout(
      () =>
        fail(
          "Voice model startup timed out. Check the offline model cache and retry.",
        ),
      60_000,
    );
  } catch (error) {
    reaped = !child;
    fail(
      error.code === "ENOENT"
        ? "uv is missing. Install uv and cache the offline voice dependencies."
        : startupError,
    );
  }
  return { send, close };
}
