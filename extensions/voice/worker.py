#!/usr/bin/env python3
"""Local Parakeet worker. The caller pins mlx-audio==0.5.3 with uv.

Stdin/stdout are NDJSON. Partial and final text are complete replacements, not
append-only deltas. Incremental decoding uses the entire bounded clip, avoiding
word-boundary guesses and overlap-merger errors. This costs more inference as a
clip grows. A fresh whole-clip final pass provides consistent final accuracy.
PCM is limited to 60 seconds, stays in RAM, and is discarded after each request.
An in-flight MLX call cannot be interrupted safely. Cancel stops capture and
invalidates its output immediately, then releases that call's input on return.

Developer mode accepts uncompressed 16 kHz mono s16 WAV, reads at most the clip
limit, emits partial/final with id 1, and exits without opening the microphone.
No model, capture, signal, or third-party import side effects occur on import.
"""

import argparse
import array
import contextlib
import json
import math
import os
import platform
import select
import signal
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass, field


DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
PARTIAL_BYTES = BYTES_PER_SECOND * 2
MAX_SECONDS = 60
CAPTURE_TIMEOUT = 5.0
PROCESS_GRACE = 0.5
MAX_CONTROL_BYTES = 4096
MIC_ERROR = "Microphone unavailable or interrupted. Check macOS microphone permission and --device."
TIMEOUT_ERROR = "Microphone capture timed out. Check microphone permission and --device."
DECODE_ERROR = "Speech decoding failed. Try again with a shorter recording."
WAV_ERROR = "Audio file must be a readable, uncompressed 16 kHz mono 16-bit WAV."


class CaptureTimeout(Exception):
    pass


def max_seconds(value):
    seconds = float(value)
    if not math.isfinite(seconds) or not 0 < seconds <= MAX_SECONDS:
        raise argparse.ArgumentTypeError("--max-seconds must be greater than 0 and at most 60")
    return seconds


def audible(pcm):
    """Conservative silence gate, including DC-only input and tiny clips."""
    if len(pcm) < SAMPLE_RATE // 10 * 2:
        return False
    samples = array.array("h", pcm[:len(pcm) // 2 * 2])
    if sys.byteorder != "little":
        samples.byteswap()
    mean = sum(samples) / len(samples)
    variance = sum(sample * sample for sample in samples) / len(samples) - mean * mean
    return variance >= 32 * 32


def decode_pcm(decoder, pcm):
    return decoder(pcm).strip() if audible(pcm) else ""


def load_decoder(model_name):
    """Only this adapter needs MLX/NumPy. All inference runs on the main thread."""
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("Unsupported platform")
    import mlx.core as mx
    import numpy as np
    from mlx_audio.stt import load

    model = load(model_name)

    def decode(pcm):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        samples /= 32768.0
        audio = None
        try:
            audio = mx.array(samples)
            return model.generate(audio, verbose=False).text
        finally:
            samples.fill(0)
            del audio
            mx.clear_cache()

    return decode


class FFmpegCapture:
    """One AVFoundation pipe, supervised independently of MLX inference."""

    def __init__(self, device, seconds):
        self.device = device
        self.seconds = seconds
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.process = None

    def stop(self):
        self.stopped.set()
        with self.lock:
            process = self.process
            if process is None:
                return
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=PROCESS_GRACE)
                except subprocess.TimeoutExpired:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    process.wait()
            else:
                process.wait()

    def run(self, on_started, on_chunk):
        try:
            with self.lock:
                if self.stopped.is_set():
                    return
                self.process = subprocess.Popen(
                    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                     "-f", "avfoundation", "-i", self.device, "-vn", "-ac", "1",
                     "-ar", str(SAMPLE_RATE), "-t", str(self.seconds),
                     "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, bufsize=0,
                )
            on_started()
            started = last_data = time.monotonic()
            received = False
            pipe = self.process.stdout
            while not self.stopped.is_set():
                now = time.monotonic()
                if now - started >= self.seconds:
                    if not received:
                        raise CaptureTimeout()
                    break
                if now - last_data >= CAPTURE_TIMEOUT:
                    raise CaptureTimeout()
                readable, _, _ = select.select(
                    [pipe], [], [], min(0.1, self.seconds - (now - started))
                )
                if not readable:
                    continue
                chunk = os.read(pipe.fileno(), 4096)
                if not chunk:
                    if self.stopped.is_set():
                        break
                    if self.process.wait(timeout=PROCESS_GRACE) != 0 or not received:
                        raise RuntimeError("Capture ended without usable audio")
                    break
                received = True
                last_data = time.monotonic()
                if not on_chunk(chunk):
                    break
        finally:
            self.stop()
            if self.process is not None and self.process.stdout is not None:
                self.process.stdout.close()


@dataclass(eq=False)
class Session:
    id: int
    capture: object
    pcm: bytearray = field(default_factory=bytearray)
    done: bool = False
    decoded_size: int = 0
    previous_text: str = ""

    def clear(self):
        self.pcm.clear()
        self.previous_text = ""


class Worker:
    def __init__(self, decoder, emit, device=":default", seconds=60,
                 capture_factory=FFmpegCapture):
        self.decoder = decoder
        self.sink = emit
        self.device = device
        self.seconds = max_seconds(seconds)
        self.limit = int(self.seconds * SAMPLE_RATE) * 2
        self.capture_factory = capture_factory
        self.condition = threading.Condition(threading.RLock())
        self.session = None
        self.closed = False
        self.capture_threads = set()

    def emit(self, kind, **fields):
        # Call with the condition held so cancellation and emission are atomic.
        try:
            self.sink({"type": kind, **fields})
        except (BrokenPipeError, OSError):
            self.shutdown()

    def shutdown(self):
        with self.condition:
            self.closed = True
            session, self.session = self.session, None
            if session is not None:
                session.clear()
            self.condition.notify_all()
        if session is not None:
            session.capture.stop()

    def handle(self, command):
        if not isinstance(command, dict):
            with self.condition:
                self.emit("error", message="Expected a control JSON object.")
            return
        kind = command.get("type")
        if kind == "shutdown":
            self.shutdown()
            return
        id_ = command.get("id")
        valid_id = type(id_) is int and 0 <= id_ <= 2**53 - 1
        with self.condition:
            if self.closed:
                return
            if kind not in ("start", "stop", "cancel") or not valid_id:
                self.emit("error", message="Expected start, stop or cancel with an integer id.")
                return
            session = self.session
            if kind == "start":
                if session is not None:
                    self.emit("error", id=id_, message="A recording is already active.")
                    return
                session = Session(id_, self.capture_factory(self.device, self.seconds))
                self.session = session
                thread = threading.Thread(target=self._capture, args=(session,), daemon=True)
                self.capture_threads.add(thread)
                thread.start()
                return
            if session is None or session.id != id_:
                self.emit("error", id=id_, message="No active recording with this id.")
                return
            if kind == "cancel":
                self.session = None
                session.clear()
                self.emit("cancelled", id=id_)
            self.condition.notify_all()
        # Never wait for an MLX call to stop the microphone.
        session.capture.stop()

    def _capture(self, session):
        def on_started():
            with self.condition:
                if self.session is session and not self.closed:
                    self.emit("recording", id=session.id)

        def on_chunk(chunk):
            with self.condition:
                if self.session is not session or self.closed:
                    return False
                remaining = self.limit - len(session.pcm)
                session.pcm.extend(chunk[:remaining])
                self.condition.notify_all()
                return len(session.pcm) < self.limit

        failure = None
        try:
            session.capture.run(on_started, on_chunk)
        except FileNotFoundError:
            failure = "ffmpeg is missing. Install ffmpeg to use local voice input."
        except CaptureTimeout:
            failure = TIMEOUT_ERROR
        except Exception:
            failure = MIC_ERROR
        finally:
            with self.condition:
                if self.session is session and not self.closed:
                    if failure:
                        self.session = None
                        session.clear()
                        self.emit("error", id=session.id, message=failure)
                    else:
                        # Ignore a trailing incomplete s16 sample, never pad it.
                        del session.pcm[len(session.pcm) // 2 * 2:]
                        session.done = True
                self.capture_threads.discard(threading.current_thread())
                self.condition.notify_all()

    def read_controls(self, stream):
        try:
            while True:
                line = stream.readline(MAX_CONTROL_BYTES + 1)
                if not line:
                    return
                if len(line) > MAX_CONTROL_BYTES:
                    with self.condition:
                        self.emit("error", message="Control line exceeds the size limit.")
                    return
                if not line.strip():
                    continue
                try:
                    command = json.loads(line)
                except (ValueError, UnicodeError, RecursionError):
                    with self.condition:
                        self.emit("error", message="Invalid control JSON.")
                    continue
                self.handle(command)
                if self.closed:
                    return
        except (OSError, UnicodeError):
            with self.condition:
                self.emit("error", message="Could not read control input.")
        finally:
            self.shutdown()

    def step(self):
        """Perform at most one serial decode. Return whether work was available."""
        with self.condition:
            session = self.session
            if self.closed or session is None:
                return False
            if not session.done and len(session.pcm) - session.decoded_size < PARTIAL_BYTES:
                return False
            final = session.done
            size = len(session.pcm) // 2 * 2
            pcm = bytearray(session.pcm[:size])
            session.decoded_size = size
        failed = False
        try:
            text = decode_pcm(self.decoder, pcm)
        except Exception:
            failed = True
        finally:
            pcm.clear()
        with self.condition:
            if self.closed or self.session is not session:
                return True  # A late decode can never revive a cancelled session/id.
            if failed:
                self.session = None
                session.clear()
                self.emit("error", id=session.id, message=DECODE_ERROR)
            elif final:
                self.session = None
                session.clear()
                self.emit("final", id=session.id, text=text)
            elif text != session.previous_text:
                session.previous_text = text
                self.emit("partial", id=session.id, text=text)
        if failed:
            session.capture.stop()
        return True

    def run(self, stream):
        try:
            with self.condition:
                if self.closed:
                    return
                self.emit("ready")
            reader = threading.Thread(target=self.read_controls, args=(stream,), daemon=True)
            reader.start()
            while True:
                with self.condition:
                    if self.closed:
                        return
                    session = self.session
                    if session is None or (
                        not session.done and len(session.pcm) - session.decoded_size < PARTIAL_BYTES
                    ):
                        self.condition.wait()
                        continue
                self.step()
        finally:
            self.shutdown()
            with self.condition:
                threads = list(self.capture_threads)
            for thread in threads:
                thread.join(timeout=PROCESS_GRACE * 3)


def read_wav(path, seconds):
    try:
        with wave.open(os.fspath(path), "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate(),
                    source.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError()
            return bytearray(source.readframes(int(max_seconds(seconds) * SAMPLE_RATE)))
    except (OSError, EOFError, ValueError, wave.Error):
        raise ValueError(WAV_ERROR) from None


def transcribe_file(decoder, pcm, emit):
    """Same silence gate and decoder as live input. No capture object is created."""
    prefix = bytearray(pcm[:PARTIAL_BYTES])
    try:
        emit({"type": "partial", "id": 1, "text": decode_pcm(decoder, prefix)})
        emit({"type": "final", "id": 1, "text": decode_pcm(decoder, pcm)})
    except Exception:
        emit({"type": "error", "id": 1, "message": DECODE_ERROR})
        return 1
    finally:
        prefix.clear()
        pcm.clear()
    return 0


@contextlib.contextmanager
def protocol_output():
    """Reserve stdout for JSON, redirect even native dependency fd-1 prints."""
    stdout_fd = sys.stdout.fileno()
    saved = os.dup(stdout_fd)
    output = os.fdopen(os.dup(saved), "w", encoding="utf-8", buffering=1)
    lock = threading.Lock()

    def emit(event):
        with lock:
            output.write(json.dumps(event, ensure_ascii=True) + "\n")
            output.flush()

    try:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), stdout_fd)
        with contextlib.redirect_stdout(sys.stderr):
            yield emit
    finally:
        sys.stderr.flush()
        os.dup2(saved, stdout_fd)
        os.close(saved)
        with contextlib.suppress(BrokenPipeError):
            output.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default=":default")
    parser.add_argument("--max-seconds", type=max_seconds, default=60)
    parser.add_argument("--audio-file", metavar="PATH")
    args = parser.parse_args(argv)
    with protocol_output() as emit:
        worker = Worker(None, emit, args.device, args.max_seconds)
        previous_handlers = {}
        pcm = bytearray()

        def interrupted(signum, frame):
            worker.shutdown()
            raise SystemExit(0)

        try:
            for sig in (signal.SIGTERM, signal.SIGINT):
                previous_handlers[sig] = signal.signal(sig, interrupted)
            if args.audio_file is not None:
                try:
                    pcm = read_wav(args.audio_file, args.max_seconds)
                except ValueError:
                    emit({"type": "error", "message": WAV_ERROR})
                    return 1
            try:
                worker.decoder = load_decoder(args.model)
            except Exception:
                emit({"type": "error", "message":
                      "Could not load local speech model. Requires macOS arm64 and mlx-audio==0.5.3."})
                return 1
            if args.audio_file is not None:
                emit({"type": "ready"})
                return transcribe_file(worker.decoder, pcm, emit)
            worker.run(sys.stdin)
            return 0
        finally:
            worker.shutdown()
            pcm.clear()
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
