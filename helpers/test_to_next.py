"""Synthetic Reminders tests. No osascript, app access or dependency fetching."""

import io
import json
import sys
import unittest
from unittest import mock

import to_next as tn


class FakeBackend:
    def __init__(self, titles=()):
        self.tasks = [{"id": f"x{i}", "title": t, "due": None} for i, t in enumerate(titles)]
        self.added = []
        self.lists = []

    def open_tasks(self, list_name):
        self.lists.append(list_name)
        return list(self.tasks)

    def add(self, list_name, title, notes=""):
        self.lists.append(list_name)
        self.added.append(title)
        self.tasks.append({"id": f"n{len(self.added)}", "title": title, "due": None})
        return f"n{len(self.added)}"


class ToNext(unittest.TestCase):
    def test_dry_run_touches_nothing(self):
        backend = FakeBackend()
        result = tn.to_next(backend, "Synthetic Actions", ["Review synthetic estimate"], apply=False)
        self.assertEqual(result["added"], ["Review synthetic estimate"])
        self.assertEqual(backend.added, [])
        self.assertEqual(backend.lists, ["Synthetic Actions"])

    def test_apply_adds_to_selected_list(self):
        backend = FakeBackend()
        tn.to_next(backend, "Synthetic Actions", ["Review synthetic estimate", "Book test appointment"], apply=True)
        self.assertEqual(backend.added, ["Review synthetic estimate", "Book test appointment"])
        self.assertEqual(backend.lists, ["Synthetic Actions"] * 3)

    def test_skips_open_duplicates_case_and_space_insensitive(self):
        backend = FakeBackend(["Review synthetic estimate"])
        result = tn.to_next(backend, "Next", ["review synthetic  estimate", "Book test appointment"], apply=True)
        self.assertEqual(result["skipped"], ["review synthetic estimate"])
        self.assertEqual(backend.added, ["Book test appointment"])

    def test_skips_duplicates_within_one_call(self):
        backend = FakeBackend()
        result = tn.to_next(backend, "Next", ["Call synthetic contact"] * 2, apply=True)
        self.assertEqual(backend.added, ["Call synthetic contact"])
        self.assertEqual(result["skipped"], ["Call synthetic contact"])

    def test_skips_blank(self):
        backend = FakeBackend()
        result = tn.to_next(backend, "Next", ["   "], apply=True)
        self.assertEqual(backend.added, [])
        self.assertEqual(result["skipped"], [""])

    def run_cli(self, *args, titles=()):
        backend = FakeBackend(titles)
        output = io.StringIO()
        with mock.patch.object(tn, "build_backend", return_value=backend), \
                mock.patch.object(sys, "argv", ["to_next.py", *args]), \
                mock.patch("sys.stdout", output):
            tn.main()
        return json.loads(output.getvalue()), backend

    def test_cli_listing_propagates_list_without_writes(self):
        result, backend = self.run_cli("--list", "Synthetic Actions", titles=["Read fixture"])
        self.assertEqual(result, [{"title": "Read fixture", "due": None}])
        self.assertEqual(backend.lists, ["Synthetic Actions"])
        self.assertEqual(backend.added, [])

    def test_cli_default_is_preview_and_double_dash_preserves_title(self):
        for flags, mode in (([], "dry-run"), (["--apply"], "apply")):
            result, backend = self.run_cli("--list", "Synthetic Actions", *flags, "--", "--synthetic-title")
            self.assertEqual(result["mode"], mode)
            self.assertEqual(result["list"], "Synthetic Actions")
            self.assertEqual(backend.added, ["--synthetic-title"] if flags else [])


if __name__ == "__main__":
    unittest.main()
