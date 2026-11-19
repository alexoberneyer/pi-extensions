// UI fixture only. No audio capture, speech model or recognition timing claim.
export const transcript = "Add a retry limit to the webhook handler.";

export function createDemoWorker({ onEvent }) {
  const timers = new Set();
  let closed = false;
  const later = (ms, event) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) onEvent(event);
    }, ms);
    timers.add(timer);
  };
  const clear = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  later(200, { type: "ready" });
  return {
    send(event) {
      if (closed) return false;
      clear();
      if (event.type === "start") {
        onEvent({ type: "recording", id: event.id });
        later(1200, {
          type: "partial",
          id: event.id,
          text: "Add a retry limit",
        });
        later(3000, { type: "partial", id: event.id, text: transcript });
      } else if (event.type === "stop")
        later(800, { type: "final", id: event.id, text: transcript });
      return true;
    },
    async close() {
      closed = true;
      clear();
    },
  };
}
