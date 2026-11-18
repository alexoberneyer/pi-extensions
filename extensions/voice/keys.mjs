/** Gesture state only. Escape and ordinary editor input always pass through. */
export class VoiceKeys {
  #options;
  #held;
  #spaceTimer;
  #spaceStarted = false;

  constructor(options) {
    this.#options = { holdMs: 300, ...options };
  }

  reset() {
    clearTimeout(this.#spaceTimer);
    this.#spaceTimer = undefined;
    this.#spaceStarted = false;
    this.#held = undefined;
  }

  #tap() {
    const { getContext, onTapSpace } = this.#options;
    this.reset();
    const context = getContext();
    if (context.atMain && context.spaceAllowed) onTapSpace();
  }

  flushTap() {
    if (this.#spaceTimer) this.#tap();
  }

  handle({
    key,
    release = false,
    repeat = false,
    encoded = false,
    text = false,
  }) {
    const o = this.#options;
    const context = o.getContext();
    if (!context.enabled) return;
    const base = key?.split("+").at(-1);
    if (this.#held && base === this.#held.base) {
      if (release) {
        const spaceTap = this.#held.space && !this.#spaceStarted;
        if (spaceTap) this.#tap();
        else {
          this.reset();
          o.onStop();
        }
      }
      return { consume: true };
    }
    // Flush a pending tap before another key, including Escape. It is not a
    // dictation cancellation, and the other key still reaches Vim/Pi normally.
    if (this.#spaceTimer && (key || text) && !release && !repeat) this.#tap();
    if (key === o.shortcut && context.atMain) {
      if (!release && !repeat) {
        if (context.active) o.onStop();
        else if (context.ready || context.pending) {
          if (
            context.ready &&
            o.mode === "hold" &&
            encoded &&
            context.releaseSupported
          )
            this.#held = { base, space: false };
          o.onStart();
        }
      }
      return { consume: true };
    }
    if (
      key === "space" &&
      !release &&
      !repeat &&
      encoded &&
      context.atMain &&
      context.ready &&
      context.spaceEnabled &&
      context.spaceAllowed &&
      context.releaseSupported
    ) {
      this.#held = { base: "space", space: true };
      this.#spaceTimer = setTimeout(() => {
        this.#spaceTimer = undefined;
        const current = o.getContext();
        if (!current.atMain || !current.spaceAllowed || !current.ready) {
          this.reset();
          return;
        }
        this.#spaceStarted = true;
        o.onStart();
      }, o.holdMs);
      return { consume: true };
    }
  }
}
