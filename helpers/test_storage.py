"""Private-cache regression tests. No desktop data or codec dependencies."""

import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import remarkable as rm


class PrivateCache(unittest.TestCase):
    def test_default_cache_is_outside_installed_source(self):
        self.assertTrue(rm.CACHE.is_absolute())
        self.assertFalse(rm.CACHE.is_relative_to(Path(rm.__file__).resolve().parent))
        self.assertEqual(rm.CACHE.name, "remarkable")
        self.assertEqual(rm.CACHE.parent.name, "pi-extensions")

    def test_legacy_filing_is_atomic_private_and_outside_source(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            ledger = cache / "filed.json"
            document = {"id": "synthetic", "name": "Synthetic notebook", "modified": 1}
            with mock.patch.object(rm, "LEDGER_FILE", ledger):
                rm.record_filed({"synthetic": "notes/example.md"}, {"synthetic": document})
                self.assertEqual(rm.load_ledger()["synthetic"]["title"], document["name"])
                self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(ledger.stat().st_mode), 0o600)
                self.assertEqual(list(cache.iterdir()), [ledger])

    def test_legacy_ink_uses_private_output_and_does_not_follow_existing_link(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            output = base / "private-pages"
            output.mkdir(mode=0o755)
            other = base / "unrelated"
            other.write_text("preserve")
            (output / "synthetic-1.png").symlink_to(other)
            document = {"name": "Synthetic", "modified": 1, "pages": [base / "page.rm"]}

            def render(_strokes, path):
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                path.write_bytes(b"synthetic image")

            with mock.patch.object(rm, "PAGES_DIR", output), \
                    mock.patch.object(rm, "read_page", return_value=("", [object()])), \
                    mock.patch.object(rm, "render_png", side_effect=render), \
                    mock.patch("builtins.print"):
                with self.assertRaises(rm.CaptureError):
                    rm.print_text(["synthetic"], {"synthetic": document})
                (output / "synthetic-1.png").unlink()
                rm.print_text(["synthetic"], {"synthetic": document})
            image = output / "synthetic-1.png"
            self.assertEqual(image.read_bytes(), b"synthetic image")
            self.assertEqual(stat.S_IMODE(image.stat().st_mode), 0o600)
            self.assertEqual(other.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
