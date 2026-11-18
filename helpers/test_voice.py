"""Stdlib-only synthetic speech-worker tests. Never record or load real models."""

import contextlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import wave


WORKER_PATH = Path(__file__).resolve().parents[1] / "extensions" / "voice" / "worker.py"
spec = importlib.util.spec_from_file_location("local_voice_worker", WORKER_PATH)
voice = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = voice
spec.loader.exec_module(voice)


def synthetic_pcm(seconds=0.2, amplitude=1000):
    """Generated tone only. No recorded or personally sourced fixtures."""
    return struct.pack("<h", amplitude) + b"".join(
        struct.pack("<h", int(amplitude * math.sin(i * 0.17)))
        for i in range(max(0, int(voice.SAMPLE_RATE * seconds) - 1))
    )


def wait_until(predicate):
    deadline = time.monotonic() + 2
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Synthetic worker did not reach the expected state")
        time.sleep(0.002)


class FakeCapture:
    def __init__(self, device=":default", seconds=60):
        self.device = device
        self.seconds = seconds
        self.stopped = threading.Event()
        self.started = threading.Event()
        self.chunks = queue.Queue()

    def stop(self):
        self.stopped.set()

    def run(self, on_started, on_chunk):
        try:
            on_started()
            self.started.set()
            while not self.stopped.is_set():
                try:
                    chunk = self.chunks.get(timeout=0.01)
                except queue.Empty:
                    continue
                if chunk is None or not on_chunk(chunk):
                    return
        finally:
            self.stop()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.capture = FakeCapture()
        self.decoder = mock.Mock(return_value="Synthetic phrase.")
        self.factory = mock.Mock(return_value=self.capture)
        self.worker = voice.Worker(self.decoder, self.events.append,
                                   capture_factory=self.factory)
        self.addCleanup(self.close_worker)

    def close_worker(self):
        self.worker.shutdown()
        for thread in list(self.worker.capture_threads):
            thread.join(timeout=2)

    def start(self, id_=1):
        self.worker.handle({"type": "start", "id": id_})
        self.assertTrue(self.capture.started.wait(2))
        return self.worker.session

    def feed(self, pcm):
        session = self.worker.session
        expected = min(self.worker.limit, len(session.pcm) + len(pcm))
        self.capture.chunks.put(pcm)
        wait_until(lambda: len(session.pcm) == expected)
        return session

    def finish(self):
        session = self.worker.session
        self.capture.chunks.put(None)
        wait_until(lambda: session.done)
        self.assertTrue(self.worker.step())

    def test_import_does_not_import_mlx_or_numpy(self):
        # Intercept imports even when these packages happen to be installed.
        original = __import__

        def guarded(name, *args, **kwargs):
            self.assertFalse(name.split(".")[0] in ("mlx", "mlx_audio", "numpy"))
            return original(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=guarded), \
                mock.patch.object(voice.subprocess, "Popen") as popen:
            spec.loader.exec_module(voice)
        popen.assert_not_called()

    def test_ready_then_eof_never_opens_microphone(self):
        self.worker.run(io.StringIO(""))
        self.assertEqual(self.events, [{"type": "ready"}])
        self.factory.assert_not_called()
        self.decoder.assert_not_called()
        self.assertTrue(self.worker.closed)

    def test_ndjson_control_loop_and_serial_main_thread_inference(self):
        commands = queue.Queue()
        stream = mock.Mock()
        stream.readline.side_effect = lambda limit: commands.get()
        failures = []

        def decode(pcm):
            self.assertIs(threading.current_thread(), threading.main_thread())
            return "Synthetic phrase."

        def controls():
            try:
                commands.put('{"type":"start","id":1}\n')
                self.assertTrue(self.capture.started.wait(2))
                self.capture.chunks.put(synthetic_pcm(2))
                wait_until(lambda: any(event["type"] == "partial" for event in self.events))
                commands.put('{"type":"stop","id":1}\n')
                wait_until(lambda: any(event["type"] == "final" for event in self.events))
            except Exception as error:
                failures.append(error)
            finally:
                commands.put('{"type":"shutdown"}\n')

        self.worker.decoder = decode
        control = threading.Thread(target=controls)
        control.start()
        self.worker.run(stream)
        control.join(2)
        self.assertEqual(failures, [])
        self.assertEqual([event["type"] for event in self.events],
                         ["ready", "recording", "partial", "final"])
        self.assertTrue(self.capture.stopped.is_set())

    def test_microphone_requires_explicit_start(self):
        self.worker.handle({"type": "stop", "id": 1})
        self.worker.handle({"type": "cancel", "id": 1})
        self.factory.assert_not_called()
        self.start(7)
        self.factory.assert_called_once_with(":default", 60)
        self.assertEqual(self.events[-1], {"type": "recording", "id": 7})

    def test_partial_and_final_are_full_replacements_with_fresh_final_decode(self):
        self.decoder.side_effect = ["A synthetic", "A synthetic example", "A synthetic example."]
        session = self.start()
        self.feed(synthetic_pcm(2))
        self.worker.step()
        self.feed(synthetic_pcm(2))
        self.worker.step()
        self.finish()
        texts = [event["text"] for event in self.events if "text" in event]
        self.assertEqual(texts, ["A synthetic", "A synthetic example", "A synthetic example."])
        self.assertEqual([event["type"] for event in self.events],
                         ["recording", "partial", "partial", "final"])
        self.assertEqual(self.decoder.call_count, 3)
        self.assertEqual(session.pcm, b"")
        self.assertEqual(session.previous_text, "")
        # Decoder input snapshots are cleared even if a fake decoder retains them.
        for call in self.decoder.call_args_list:
            self.assertEqual(call.args[0], b"")

    def test_incremental_decode_receives_entire_clip_not_append_only_windows(self):
        lengths = []
        self.worker.decoder = lambda pcm: lengths.append(len(pcm)) or "Synthetic result"
        self.start()
        self.feed(synthetic_pcm(2))
        self.worker.step()
        self.feed(synthetic_pcm(2))
        self.worker.step()
        self.finish()
        self.assertEqual(lengths, [voice.PARTIAL_BYTES, voice.PARTIAL_BYTES * 2,
                                   voice.PARTIAL_BYTES * 2])
        self.assertEqual(sum(event["type"] == "partial" for event in self.events), 1)

    def test_stop_closes_capture_and_finalizes(self):
        self.start(3)
        self.feed(synthetic_pcm())
        self.worker.handle({"type": "stop", "id": 3})
        self.assertTrue(self.capture.stopped.is_set())
        wait_until(lambda: self.worker.session.done)
        self.worker.step()
        self.assertEqual(self.events[-1], {"type": "final", "id": 3, "text": "Synthetic phrase."})

    def test_cancel_during_decode_stops_capture_and_rejects_late_text(self):
        session = self.start()
        self.feed(synthetic_pcm(2))
        entered = threading.Event()
        cancelled = threading.Event()

        def decode(pcm):
            self.assertIs(threading.current_thread(), threading.main_thread())
            entered.set()
            self.assertTrue(cancelled.wait(2))
            self.assertTrue(self.capture.stopped.is_set())
            self.assertEqual(session.pcm, b"")
            return "Late synthetic text must not be emitted"

        def cancel():
            if entered.wait(2):
                self.worker.handle({"type": "cancel", "id": 1})
            cancelled.set()

        self.worker.decoder = decode
        control = threading.Thread(target=cancel)
        control.start()
        self.worker.step()
        control.join(2)
        self.assertFalse(control.is_alive())
        self.assertEqual(self.events[-1], {"type": "cancelled", "id": 1})
        self.assertFalse(any("text" in event for event in self.events))
        self.assertIsNone(self.worker.session)

    def test_stop_during_decode_remains_responsive(self):
        self.start()
        self.feed(synthetic_pcm(2))
        entered = threading.Event()
        stopped = threading.Event()

        def decode(pcm):
            entered.set()
            self.assertTrue(stopped.wait(2))
            self.assertTrue(self.capture.stopped.is_set())
            return "Synthetic phrase."

        def stop():
            if entered.wait(2):
                self.worker.handle({"type": "stop", "id": 1})
            stopped.set()

        self.worker.decoder = decode
        control = threading.Thread(target=stop)
        control.start()
        self.worker.step()
        control.join(2)
        wait_until(lambda: self.worker.session.done)
        self.worker.step()
        self.assertEqual(self.events[-1]["type"], "final")

    def test_cancelled_id_can_be_reused_without_reviving_old_decode(self):
        self.start()
        self.feed(synthetic_pcm(2))
        replacement = FakeCapture()

        def decode(pcm):
            self.worker.handle({"type": "cancel", "id": 1})
            self.factory.return_value = replacement
            self.worker.handle({"type": "start", "id": 1})
            return "Discard this synthetic result"

        self.worker.decoder = decode
        self.worker.step()
        self.assertIs(self.worker.session.capture, replacement)
        self.assertFalse(any("text" in event for event in self.events))
        self.assertTrue(self.capture.stopped.is_set())

    def test_pcm_cap_stops_capture_independently_of_inference(self):
        self.worker.limit = voice.BYTES_PER_SECOND // 4
        session = self.start()
        self.feed(synthetic_pcm(1))
        wait_until(lambda: session.done)
        self.assertEqual(len(session.pcm), self.worker.limit)
        self.assertTrue(self.capture.stopped.is_set())
        self.worker.step()
        self.assertEqual(self.events[-1]["type"], "final")
        self.assertEqual(session.pcm, b"")

    def test_silence_dc_short_and_empty_audio_do_not_call_decoder(self):
        for pcm in (b"", b"\0" * voice.BYTES_PER_SECOND,
                    struct.pack("<h", 1000) * voice.SAMPLE_RATE,
                    synthetic_pcm(0.02)):
            with self.subTest(length=len(pcm)):
                self.capture = FakeCapture()
                self.factory.return_value = self.capture
                self.start()
                self.feed(pcm)
                self.finish()
                self.assertEqual(self.events[-1]["text"], "")
        self.decoder.assert_not_called()

    def test_odd_trailing_sample_is_ignored(self):
        lengths = []
        self.worker.decoder = lambda pcm: lengths.append(len(pcm)) or "Synthetic result"
        self.start()
        pcm = synthetic_pcm() + b"\x7f"
        self.feed(pcm)
        self.finish()
        self.assertEqual(lengths, [len(pcm) - 1])

    def test_busy_or_mismatched_id_does_not_replace_or_stop_session(self):
        session = self.start(4)
        for command in ({"type": "start", "id": 5}, {"type": "cancel", "id": 5},
                        {"type": "stop", "id": 5}):
            self.worker.handle(command)
            self.assertEqual(self.events[-1]["type"], "error")
            self.assertIs(self.worker.session, session)
            self.assertFalse(self.capture.stopped.is_set())
        self.factory.assert_called_once()

    def test_malformed_commands_do_not_echo_input_or_start_capture(self):
        for command in (None, [], {}, {"type": "synthetic payload", "id": 1},
                        {"type": "start", "id": True}, {"type": "start", "id": 1.5},
                        {"type": "start", "id": -1}, {"type": "start", "id": 2**53}):
            self.worker.handle(command)
        self.factory.assert_not_called()
        self.assertTrue(all(event["type"] == "error" for event in self.events))
        self.assertNotIn("synthetic payload", json.dumps(self.events))

    def test_invalid_ndjson_and_overlong_lines_are_safe(self):
        self.worker.read_controls(io.StringIO("synthetic invalid JSON\n"))
        self.assertEqual(self.events[0]["message"], "Invalid control JSON.")
        self.assertTrue(self.worker.closed)
        self.assertNotIn("synthetic invalid", json.dumps(self.events))

    def test_deeply_nested_json_is_rejected_without_echo(self):
        self.worker.read_controls(io.StringIO("[" * 1500 + "]" * 1500 + "\n"))
        self.assertEqual(self.events[0]["message"], "Invalid control JSON.")
        self.assertTrue(self.worker.closed)
        self.factory.assert_not_called()

    def test_broken_protocol_pipe_closes_capture_and_discards_audio(self):
        session = self.start()
        self.feed(synthetic_pcm(2))
        self.worker.sink = mock.Mock(side_effect=BrokenPipeError())
        self.worker.step()
        self.assertTrue(self.worker.closed)
        self.assertTrue(self.capture.stopped.is_set())
        self.assertEqual(session.pcm, b"")

    def test_oversized_control_line_closes_worker_without_capture(self):
        self.worker.read_controls(io.StringIO("x" * (voice.MAX_CONTROL_BYTES + 2)))
        self.assertEqual(self.events[-1]["message"], "Control line exceeds the size limit.")
        self.assertTrue(self.worker.closed)
        self.factory.assert_not_called()

    def test_eof_and_shutdown_discard_active_audio(self):
        for finish in (lambda: self.worker.read_controls(io.StringIO("")),
                       lambda: self.worker.handle({"type": "shutdown"})):
            with self.subTest(finish=finish):
                self.worker.closed = False
                self.capture = FakeCapture()
                self.factory.return_value = self.capture
                session = self.start()
                self.feed(synthetic_pcm())
                finish()
                self.assertTrue(self.capture.stopped.is_set())
                self.assertEqual(session.pcm, b"")
                self.assertTrue(self.worker.closed)
                self.assertIsNone(self.worker.session)

    def test_shutdown_during_decode_rejects_late_output(self):
        self.start()
        self.feed(synthetic_pcm(2))

        def decode(pcm):
            self.worker.shutdown()
            return "Discard this synthetic result"

        self.worker.decoder = decode
        self.worker.step()
        self.assertTrue(self.worker.closed)
        self.assertFalse(any("text" in event for event in self.events))

    def test_decoder_failure_clears_audio_stops_mic_and_hides_exception(self):
        session = self.start()
        self.feed(synthetic_pcm(2))
        self.decoder.side_effect = RuntimeError("synthetic secret transcript")
        self.worker.step()
        self.assertEqual(self.events[-1], {"type": "error", "id": 1,
                                           "message": voice.DECODE_ERROR})
        self.assertEqual(session.pcm, b"")
        self.assertTrue(self.capture.stopped.is_set())
        self.assertNotIn("synthetic secret", json.dumps(self.events))

    def test_capture_failures_have_short_safe_errors(self):
        cases = [(FileNotFoundError("synthetic path"), "ffmpeg is missing"),
                 (voice.CaptureTimeout("synthetic detail"), "timed out"),
                 (RuntimeError("synthetic secret transcript"), "Microphone unavailable")]
        for exception, expected in cases:
            with self.subTest(exception=type(exception)):
                capture = mock.Mock()
                capture.run.side_effect = exception
                self.factory.return_value = capture
                self.worker.handle({"type": "start", "id": 1})
                wait_until(lambda: self.worker.session is None)
                self.assertIn(expected, self.events[-1]["message"])
                self.assertNotIn("synthetic", json.dumps(self.events[-1]))

    def test_model_is_kept_warm_across_sessions(self):
        for id_ in (1, 2):
            self.capture = FakeCapture()
            self.factory.return_value = self.capture
            self.start(id_)
            self.feed(synthetic_pcm())
            self.finish()
        self.assertIs(self.worker.decoder, self.decoder)
        self.assertEqual(self.decoder.call_count, 2)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.process = mock.Mock()
        self.process.poll.return_value = None
        self.process.wait.return_value = 0
        self.process.stdout.fileno.return_value = 7
        self.popen = mock.patch.object(voice.subprocess, "Popen", return_value=self.process).start()
        self.select = mock.patch.object(voice.select, "select",
                                       return_value=([self.process.stdout], [], [])).start()
        self.read = mock.patch.object(voice.os, "read", side_effect=[synthetic_pcm(), b""]).start()
        self.addCleanup(mock.patch.stopall)
        self.capture = voice.FFmpegCapture(":default", 60)

    def test_avfoundation_command_has_only_pcm_stdout_and_no_files_or_logs(self):
        started = mock.Mock()
        chunks = []
        self.capture.run(started, lambda chunk: chunks.append(chunk) or True)
        command = self.popen.call_args.args[0]
        kwargs = self.popen.call_args.kwargs
        self.assertEqual(command[command.index("-f") + 1], "avfoundation")
        self.assertEqual(command[command.index("-i") + 1], ":default")
        self.assertEqual(command[command.index("-ar") + 1], "16000")
        self.assertEqual(command[command.index("-ac") + 1], "1")
        self.assertEqual(command[-5:], ["-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"])
        self.assertEqual(command[-1], "pipe:1")
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        started.assert_called_once()
        self.assertEqual(len(chunks), 1)
        self.process.terminate.assert_called_once()
        self.process.stdout.close.assert_called_once()

    def test_terminate_then_kill_and_wait(self):
        self.capture.process = self.process
        self.process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 0.5), 0]
        self.capture.stop()
        self.assertEqual(self.process.method_calls, [mock.call.poll(), mock.call.terminate(),
                         mock.call.wait(timeout=voice.PROCESS_GRACE), mock.call.kill(),
                         mock.call.wait()])

    def test_already_exited_process_is_still_reaped(self):
        self.capture.process = self.process
        self.process.poll.return_value = 0
        self.capture.stop()
        self.process.terminate.assert_not_called()
        self.process.wait.assert_called_once_with()

    def test_cancel_before_spawn_never_opens_microphone(self):
        self.capture.stop()
        started = mock.Mock()
        self.capture.run(started, mock.Mock())
        self.popen.assert_not_called()
        started.assert_not_called()

    def test_eof_without_audio_and_ffmpeg_failure_stop_mic(self):
        for returncode in (0, 1):
            with self.subTest(returncode=returncode):
                capture = voice.FFmpegCapture(":default", 60)
                self.read.side_effect = [b""]
                self.process.wait.return_value = returncode
                with self.assertRaises(RuntimeError):
                    capture.run(mock.Mock(), mock.Mock())
                self.assertTrue(capture.stopped.is_set())
        self.assertEqual(self.process.stdout.close.call_count, 2)

    def test_stalled_capture_times_out_without_main_thread_help(self):
        self.select.return_value = ([], [], [])
        with mock.patch.object(voice.time, "monotonic", side_effect=[0, 0, 6]):
            with self.assertRaises(voice.CaptureTimeout):
                self.capture.run(mock.Mock(), mock.Mock())
        self.process.terminate.assert_called_once()
        self.process.stdout.close.assert_called_once()

    def test_wall_duration_cap_stops_mic_without_main_thread_help(self):
        self.capture.seconds = 0.25
        with mock.patch.object(voice.time, "monotonic", side_effect=[0, 0, 0, 0.3]):
            self.capture.run(mock.Mock(), lambda chunk: True)
        self.process.terminate.assert_called_once()
        self.assertEqual(self.read.call_count, 1)

    def test_buffer_cap_callback_stops_capture(self):
        self.capture.run(mock.Mock(), lambda chunk: False)
        self.assertEqual(self.read.call_count, 1)
        self.assertTrue(self.capture.stopped.is_set())

    def test_pipe_read_failure_closes_and_reaps_capture(self):
        self.read.side_effect = OSError("synthetic read error")
        with self.assertRaises(OSError):
            self.capture.run(mock.Mock(), mock.Mock())
        self.process.terminate.assert_called_once()
        self.process.stdout.close.assert_called_once()

    def test_missing_ffmpeg_does_not_emit_recording(self):
        self.popen.side_effect = FileNotFoundError("synthetic missing executable")
        started = mock.Mock()
        with self.assertRaises(FileNotFoundError):
            self.capture.run(started, mock.Mock())
        started.assert_not_called()


class DeveloperModeTests(unittest.TestCase):
    def wav(self, directory, pcm, channels=1, rate=16000):
        path = Path(directory) / "synthetic-tone.wav"
        with wave.open(str(path), "wb") as output:
            output.setnchannels(channels)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(pcm)
        return path

    def test_wav_read_is_bounded_and_file_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav(directory, synthetic_pcm(1))
            self.assertEqual(len(voice.read_wav(path, 0.25)), voice.BYTES_PER_SECOND // 4)
            path.unlink()

    def test_invalid_or_missing_wav_has_safe_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav(directory, synthetic_pcm(), channels=2)
            for candidate in (path, Path(directory) / "synthetic-missing.wav"):
                with self.assertRaisesRegex(ValueError, "16 kHz mono 16-bit WAV"):
                    voice.read_wav(candidate, 60)

    def test_file_mode_emits_partial_and_final_using_same_decoder(self):
        events = []
        lengths = []
        pcm = bytearray(synthetic_pcm(3))
        decoder = lambda data: lengths.append(len(data)) or "Synthetic example."
        with mock.patch.object(voice.subprocess, "Popen") as popen:
            self.assertEqual(voice.transcribe_file(decoder, pcm, events.append), 0)
        popen.assert_not_called()
        self.assertEqual(lengths, [voice.PARTIAL_BYTES, voice.BYTES_PER_SECOND * 3])
        self.assertEqual([event["type"] for event in events], ["partial", "final"])
        self.assertTrue(all(event["id"] == 1 for event in events))
        self.assertEqual(pcm, b"")

    def test_silent_file_emits_empty_results_without_model_inference(self):
        events = []
        decoder = mock.Mock()
        voice.transcribe_file(decoder, bytearray(voice.BYTES_PER_SECOND), events.append)
        decoder.assert_not_called()
        self.assertEqual([event["text"] for event in events], ["", ""])

    def test_failed_file_decode_does_not_echo_exception_and_clears_pcm(self):
        events = []
        pcm = bytearray(synthetic_pcm())
        decoder = mock.Mock(side_effect=RuntimeError("synthetic secret transcript"))
        self.assertEqual(voice.transcribe_file(decoder, pcm, events.append), 1)
        self.assertEqual(events, [{"type": "error", "id": 1, "message": voice.DECODE_ERROR}])
        self.assertEqual(pcm, b"")

    def test_max_seconds_is_finite_positive_and_at_most_sixty(self):
        for invalid in (0, -1, 61, float("nan"), float("inf")):
            with self.subTest(invalid=invalid):
                with self.assertRaises(voice.argparse.ArgumentTypeError):
                    voice.max_seconds(invalid)
        self.assertEqual(voice.max_seconds("60"), 60)
        self.assertEqual(voice.max_seconds("0.25"), 0.25)

    def run_main(self, args, decoder=None, load_error=None, runner=None):
        events = []

        @contextlib.contextmanager
        def output():
            yield events.append

        with mock.patch.object(voice, "protocol_output", output), \
                mock.patch.object(voice, "load_decoder", return_value=decoder,
                                  side_effect=load_error) as load, \
                mock.patch.object(voice.Worker, "run", runner or mock.Mock()), \
                mock.patch.object(voice.subprocess, "Popen") as popen:
            result = voice.main(args)
        popen.assert_not_called()
        return result, events, load

    def test_audio_file_cli_never_opens_mic_or_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav(directory, synthetic_pcm())
            decoder = mock.Mock(return_value="Synthetic example.")
            result, events, load = self.run_main(["--audio-file", str(path)], decoder)
        self.assertEqual(result, 0)
        self.assertEqual([event["type"] for event in events], ["ready", "partial", "final"])
        self.assertEqual(decoder.call_count, 2)
        load.assert_called_once_with(voice.DEFAULT_MODEL)

    def test_invalid_file_fails_before_model_load(self):
        with tempfile.TemporaryDirectory() as directory:
            result, events, load = self.run_main(
                ["--audio-file", str(Path(directory) / "synthetic-missing.wav")])
        self.assertEqual(result, 1)
        load.assert_not_called()
        self.assertEqual(events, [{"type": "error", "message": voice.WAV_ERROR}])

    def test_empty_audio_file_argument_cannot_fall_back_to_microphone_mode(self):
        result, events, load = self.run_main(["--audio-file", ""])
        self.assertEqual(result, 1)
        load.assert_not_called()
        self.assertEqual(events, [{"type": "error", "message": voice.WAV_ERROR}])

    def test_model_load_error_is_safe_and_not_ready(self):
        result, events, _ = self.run_main([], load_error=RuntimeError("synthetic secret"))
        self.assertEqual(result, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertNotIn("synthetic secret", json.dumps(events))

    def test_sigterm_and_sigint_cleanup_and_restore_handlers(self):
        for sig in (voice.signal.SIGTERM, voice.signal.SIGINT):
            with self.subTest(signal=sig):
                previous = voice.signal.getsignal(sig)
                holder = []

                def run(worker, stream):
                    holder.append(worker)
                    capture = FakeCapture()
                    worker.capture_factory = lambda *args: capture
                    worker.handle({"type": "start", "id": 1})
                    voice.signal.getsignal(sig)(sig, None)

                with self.assertRaises(SystemExit):
                    self.run_main([], decoder=mock.Mock(), runner=run)
                self.assertTrue(holder[0].closed)
                self.assertIsNone(holder[0].session)
                self.assertIs(voice.signal.getsignal(sig), previous)


class ProtocolOutputTests(unittest.TestCase):
    def test_python_and_native_progress_go_to_stderr_not_protocol(self):
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as output, \
                tempfile.TemporaryFile(mode="w+", encoding="utf-8") as progress:
            with mock.patch.object(voice.sys, "stdout", output), \
                    mock.patch.object(voice.sys, "stderr", progress):
                with voice.protocol_output() as emit:
                    print("synthetic Python model progress")
                    os.write(output.fileno(), b"synthetic native model progress\n")
                    emit({"type": "ready"})
                    emit({"type": "partial", "id": 1, "text": "Synthetic line.\nAnother line."})
            output.seek(0)
            events = [json.loads(line) for line in output]
            self.assertEqual([event["type"] for event in events], ["ready", "partial"])
            self.assertEqual(events[1]["text"], "Synthetic line.\nAnother line.")
            progress.seek(0)
            messages = progress.read()
            self.assertIn("synthetic Python model progress", messages)
            self.assertIn("synthetic native model progress", messages)


class DecoderAdapterTests(unittest.TestCase):
    def test_pinned_api_normalizes_pcm_and_disables_transcript_printing(self):
        samples = mock.Mock()
        source = mock.Mock()
        source.astype.return_value = samples
        samples.__itruediv__ = mock.Mock(return_value=samples)
        np = types.ModuleType("numpy")
        np.float32 = "synthetic-float32"
        np.frombuffer = mock.Mock(return_value=source)
        mx = types.ModuleType("mlx.core")
        mx.array = mock.Mock(return_value="synthetic-mlx-array")
        mx.clear_cache = mock.Mock()
        mlx = types.ModuleType("mlx")
        mlx.core = mx
        stt = types.ModuleType("mlx_audio.stt")
        model = mock.Mock()
        model.generate.return_value.text = "Synthetic result."
        stt.load = mock.Mock(return_value=model)
        mlx_audio = types.ModuleType("mlx_audio")
        mlx_audio.stt = stt
        modules = {"numpy": np, "mlx": mlx, "mlx.core": mx,
                   "mlx_audio": mlx_audio, "mlx_audio.stt": stt}
        with mock.patch.dict(sys.modules, modules), \
                mock.patch.object(voice.sys, "platform", "darwin"), \
                mock.patch.object(voice.platform, "machine", return_value="arm64"):
            decoder = voice.load_decoder("synthetic-model")
            pcm = synthetic_pcm()
            self.assertEqual(decoder(pcm), "Synthetic result.")
            self.assertEqual(decoder(pcm), "Synthetic result.")
        stt.load.assert_called_once_with("synthetic-model")
        np.frombuffer.assert_called_with(pcm, dtype="<i2")
        source.astype.assert_called_with(np.float32)
        samples.__itruediv__.assert_called_with(32768.0)
        model.generate.assert_called_with("synthetic-mlx-array", verbose=False)
        samples.fill.assert_called_with(0)
        self.assertEqual(mx.clear_cache.call_count, 2)


if __name__ == "__main__":
    unittest.main()
