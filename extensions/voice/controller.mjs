import { stripVTControlCharacters } from "node:util";
import { launchWorker } from "./client.mjs";

function safeNotice(error) {
  const message = typeof error === "string" ? error : error?.message;
  if (typeof message !== "string")
    return "Voice input failed. Disable voice and retry.";
  if (/uv is missing/i.test(message))
    return "uv is missing. Install uv and cache the offline voice dependencies.";
  if (/ffmpeg is missing/i.test(message))
    return "ffmpeg is missing. Install ffmpeg to use local voice input.";
  if (/model/i.test(message))
    return "Local speech model unavailable. Check the offline Parakeet cache and macOS arm64.";
  if (/offline|mlx-audio|Python/i.test(message))
    return "Voice worker could not start offline. Cache Python 3.10 and mlx-audio==0.5.3, then retry.";
  if (/microphone/i.test(message))
    return "Microphone unavailable. Check microphone permission and the configured device.";
  if (/decoding/i.test(message))
    return "Speech decoding failed. Try again with a shorter recording.";
  return "Voice input failed. Disable voice and retry.";
}

function safeText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16 * 1024) return;
  return stripVTControlCharacters(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

/** Owns only in-memory voice state. Targets belong to the embedding editor. */
export class VoiceController {
  state = "off";
  preview = "";
  pendingText = "";

  #createWorker;
  #onChange;
  #onFinal;
  #onNotice;
  #startupMs;
  #finalizeMs;
  #recordingMs;
  #worker;
  #generation = 0;
  #nextId = 0;
  #request;
  #timer;
  #closing;
  #teardownFailed = false;

  constructor({
    createWorker = launchWorker,
    onChange = () => {},
    onFinal = () => false,
    onNotice = () => {},
    startupMs = 60_000,
    finalizeMs = 15_000,
    recordingMs = 60_000,
  } = {}) {
    this.#createWorker = createWorker;
    this.#onChange = onChange;
    this.#onFinal = onFinal;
    this.#onNotice = onNotice;
    this.#startupMs = startupMs;
    this.#finalizeMs = finalizeMs;
    this.#recordingMs = recordingMs;
  }

  get enabled() {
    return this.state !== "off";
  }

  #changed() {
    this.#onChange();
  }

  #clearTimer() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #deadline(ms, callback) {
    this.#clearTimer();
    const generation = this.#generation;
    const request = this.#request;
    this.#timer = setTimeout(() => {
      if (generation === this.#generation && request === this.#request)
        callback();
    }, ms);
  }

  #close(worker) {
    if (!worker) return this.#closing ?? Promise.resolve();
    let current;
    try {
      current = Promise.resolve(worker.close());
    } catch (error) {
      current = Promise.reject(error);
    }
    const closing = Promise.all([
      this.#closing,
      current.catch(() => {
        this.#teardownFailed = true;
        this.#onNotice(
          "Voice worker did not stop. Restart Pi before retrying.",
          "error",
        );
      }),
    ]).then(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    this.#closing = closing;
    return closing;
  }

  #fail(message) {
    void this.disable();
    this.#onNotice(message, "error");
  }

  #send(event) {
    try {
      if (this.#worker?.send(event) === false && this.enabled)
        this.#fail("Voice worker input closed. Disable voice and retry.");
    } catch {
      this.#fail("Voice worker input closed. Disable voice and retry.");
    }
  }

  enable() {
    if (this.enabled) return;
    if (this.#closing || this.#teardownFailed) {
      this.#onNotice(
        this.#teardownFailed
          ? "Voice worker did not stop. Restart Pi before retrying."
          : "Voice worker is stopping. Enable voice again after cleanup.",
        this.#teardownFailed ? "error" : "info",
      );
      return;
    }
    const generation = ++this.#generation;
    this.state = "loading";
    this.#deadline(this.#startupMs, () =>
      this.#fail(
        "Voice model startup timed out. Check the offline model cache and retry.",
      ),
    );
    this.#changed();
    try {
      const worker = this.#createWorker({
        onEvent: (event) => {
          if (generation === this.#generation && this.enabled)
            this.#event(event);
        },
        onError: (error) => {
          if (generation === this.#generation && this.enabled)
            this.#fail(safeNotice(error));
        },
      });
      // A factory can report a synchronous startup error before returning.
      if (generation !== this.#generation) void this.#close(worker);
      else this.#worker = worker;
    } catch (error) {
      if (generation === this.#generation) this.#fail(safeNotice(error));
    }
  }

  start(target) {
    if (this.state === "off") return this.enable();
    if (this.state === "pending") return this.insertPending(target);
    if (this.state !== "ready") return;
    if (this.#nextId >= Number.MAX_SAFE_INTEGER)
      return this.#fail(
        "Voice recording limit reached. Restart Pi before retrying.",
      );
    this.#request = { id: ++this.#nextId, target };
    this.preview = "";
    this.state = "starting";
    this.#deadline(this.#finalizeMs, () =>
      this.#fail(
        "Microphone did not start. Check microphone permission and retry.",
      ),
    );
    this.#send({ type: "start", id: this.#request.id });
    this.#changed();
  }

  stop() {
    if (
      !this.#request ||
      !["starting", "recording", "finalizing"].includes(this.state)
    )
      return;
    if (this.state !== "finalizing") {
      this.state = "finalizing";
      this.#deadline(this.#finalizeMs, () =>
        this.#fail(
          "Voice finalization timed out. Enable voice and try a shorter recording.",
        ),
      );
    }
    this.#send({ type: "stop", id: this.#request.id });
    this.#changed();
  }

  cancel() {
    const request = this.#request;
    this.#request = undefined;
    this.preview = "";
    this.pendingText = "";
    if (this.state !== "loading") {
      this.#clearTimer();
      if (this.enabled) this.state = "ready";
    }
    if (request) this.#send({ type: "cancel", id: request.id });
    this.#changed();
  }

  insertPending(target) {
    if (this.state !== "pending") return false;
    const generation = this.#generation;
    const text = this.pendingText;
    let delivered;
    try {
      delivered = this.#onFinal(text, target, { explicit: true }) === true;
    } catch {
      this.#fail("Voice text could not be inserted. Enable voice and retry.");
      return false;
    }
    if (
      generation !== this.#generation ||
      this.state !== "pending" ||
      this.pendingText !== text
    )
      return false;
    if (delivered) {
      this.pendingText = "";
      this.preview = "";
      this.state = "ready";
    }
    this.#changed();
    return delivered;
  }

  disable() {
    ++this.#generation;
    this.#clearTimer();
    const worker = this.#worker;
    this.#worker = undefined;
    this.#request = undefined;
    this.preview = "";
    this.pendingText = "";
    this.state = "off";
    const closing = this.#close(worker);
    this.#changed();
    return closing;
  }

  #event(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "ready") {
      if (this.state !== "loading") return;
      this.#clearTimer();
      this.state = "ready";
      this.#changed();
      return;
    }
    const request = this.#request;
    if (event.type === "error") {
      if (event.id === undefined || (request && event.id === request.id))
        this.#fail(safeNotice(event.message));
      return;
    }
    if (!request || event.id !== request.id) return;
    if (event.type === "recording") {
      if (this.state !== "starting") return;
      this.state = "recording";
      this.#deadline(this.#recordingMs, () => this.stop());
      this.#changed();
    } else if (event.type === "cancelled") {
      this.#request = undefined;
      this.cancel();
    } else if (["partial", "final"].includes(event.type)) {
      const text = safeText(event.text);
      if (text === undefined) {
        this.#fail("Voice worker sent invalid data. Disable voice and retry.");
        return;
      }
      if (event.type === "partial") {
        this.preview = text;
        this.#changed();
        return;
      }
      this.#clearTimer();
      const generation = this.#generation;
      let delivered = true;
      if (text.trim()) {
        try {
          delivered =
            this.#onFinal(text, request.target, { explicit: false }) === true;
        } catch {
          this.#fail(
            "Voice text could not be inserted. Enable voice and retry.",
          );
          return;
        }
      }
      if (generation !== this.#generation || request !== this.#request) return;
      this.#request = undefined;
      this.pendingText = delivered ? "" : text;
      this.preview = delivered ? "" : text;
      this.state = delivered ? "ready" : "pending";
      this.#changed();
    }
  }
}
