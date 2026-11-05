"""Synthetic desktop-copy tests. No tablet, app access or dependency fetching.

Run: python3 -m unittest discover -s helpers -p 'test_*.py'
Codec tests require optional rmscene and Pillow. Safety tests use stdlib mocks.
"""

import copy
import hashlib
import io
import importlib.util
import json
import stat
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent))

import remarkable as rm  # noqa: E402

HAS_PILLOW = importlib.util.find_spec("PIL") is not None
HAS_CODEC = importlib.util.find_spec("rmscene") is not None and HAS_PILLOW


def write(source: Path, doc_id: str, name: str, kind="DocumentType", parent="", modified=1000,
          pages=None, **extra):
    meta = {"visibleName": name, "type": kind, "parent": parent, "lastModified": str(modified),
            **extra}
    (source / f"{doc_id}.metadata").write_text(json.dumps(meta))
    if pages is not None:
        (source / f"{doc_id}.content").write_text(json.dumps({"cPages": {"pages": pages}}))
        (source / doc_id).mkdir()
        for page in pages:
            (source / doc_id / f"{page['id']}.rm").write_bytes(b"")


class Index(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name)
        write(self.source, "f1", "writing", kind="CollectionType")
        write(self.source, "f2", "books", kind="CollectionType")

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_live_notebooks_in_the_folder(self):
        write(self.source, "a", "optimism", parent="f1", pages=[])
        write(self.source, "b", "a-book", parent="f2", pages=[])
        write(self.source, "c", "gone", parent="f1", deleted=True)
        write(self.source, "d", "trashed", parent="trash")
        docs, _ = rm.load_index(self.source, "writing")
        self.assertEqual([d["name"] for d in docs], ["optimism"])

    def test_newest_change_spans_the_whole_copy(self):
        write(self.source, "a", "optimism", parent="f1", modified=5, pages=[])
        write(self.source, "b", "a-book", parent="f2", modified=9000, pages=[])
        _, newest = rm.load_index(self.source, "writing")
        self.assertEqual(newest, 9000)

    def test_missing_folder_says_so(self):
        with self.assertRaises(SystemExit) as ctx:
            rm.load_index(self.source, "nope")
        self.assertIn("nope", str(ctx.exception))

    def test_pages_follow_the_index_not_the_list(self):
        pages = [{"id": "p2", "idx": {"value": "bb"}}, {"id": "p1", "idx": {"value": "ba"}},
                 {"id": "p3", "idx": {"value": "bc"}, "deleted": True}]
        write(self.source, "a", "two-pages", parent="f1", pages=pages)
        docs, _ = rm.load_index(self.source, "writing")
        self.assertEqual([p.stem for p in docs[0]["pages"]], ["p1", "p2"])

    def test_a_page_never_drawn_on_is_skipped(self):
        write(self.source, "a", "blank", parent="f1",
              pages=[{"id": "p1", "idx": {"value": "ba"}}])
        (self.source / "a" / "p1.rm").unlink()
        docs, _ = rm.load_index(self.source, "writing")
        self.assertEqual(docs[0]["pages"], [])


def doc(doc_id, name, modified=1000):
    return {"id": doc_id, "name": name, "modified": modified, "pages": []}


class Handles(unittest.TestCase):
    def test_names_become_slugs_and_collisions_get_a_suffix(self):
        handles = rm.keyed([doc("a", "Meine Zukunft", 1), doc("b", "meine-zukunft", 2)])
        self.assertEqual(list(handles), ["meine-zukunft", "meine-zukunft-2"])


class Ledger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(rm, "LEDGER_FILE", Path(self.tmp.name) / "filed.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_new_filed_and_changed(self):
        handles = rm.keyed([doc("a", "new"), doc("b", "filed"), doc("c", "edited")])
        rm.record_filed({"filed": "blogposts/drafts/filed.md",
                         "edited": "blogposts/drafts/edited.md"}, handles)
        handles["edited"]["modified"] = 2000  # written on again after filing
        todo = {key: changed for key, _, changed in rm.waiting(handles, rm.load_ledger())}
        self.assertEqual(todo, {"new": False, "edited": True})

    def test_unknown_key_fails_without_writing(self):
        with self.assertRaises(SystemExit):
            rm.record_filed({"nope": "x"}, rm.keyed([doc("a", "optimism")]))
        self.assertFalse(rm.LEDGER_FILE.exists())


@unittest.skipUnless(HAS_PILLOW, "optional Pillow is not installed")
class Render(unittest.TestCase):
    def test_png_is_cropped_to_the_ink(self):
        point = lambda x, y: SimpleNamespace(x=x, y=y)  # noqa: E731
        strokes = [SimpleNamespace(points=[point(-100, 50), point(100, 50)]),
                   SimpleNamespace(points=[point(0, 300)])]
        with tempfile.TemporaryDirectory() as tmp:
            from PIL import Image
            out = rm.render_png(strokes, Path(tmp) / "p.png", margin=10)
            with Image.open(out) as img:
                self.assertEqual(img.size, (220, 270))


def uid(n):
    return str(UUID(int=n))


def page_bytes(text="typed text", ink=False, style=None):
    """Real v6 fixtures, generated locally. No desktop data in the tests."""
    from rmscene import (
        CrdtId,
        CrdtSequenceItem,
        LwwValue,
        RootTextBlock,
        SceneLineItemBlock,
        simple_text_document,
        write_blocks,
    )
    from rmscene import scene_items as si

    blocks = list(simple_text_document(text, author_uuid=UUID(int=1)))
    if style is not None:
        root_text = next(b for b in blocks if isinstance(b, RootTextBlock))
        root_text.value.styles[si.END_MARKER] = LwwValue(CrdtId(1, 15), style)
    if not text:
        blocks = [b for b in blocks if not isinstance(b, RootTextBlock)]
    if ink:
        blocks.append(SceneLineItemBlock(
            parent_id=CrdtId(0, 11),
            item=CrdtSequenceItem(
                item_id=CrdtId(1, 100), left_id=CrdtId(0, 0), right_id=CrdtId(0, 0),
                deleted_length=0,
                value=si.Line(color=si.PenColor.BLACK, tool=si.Pen.BALLPOINT_1,
                              points=[si.Point(0, 0, 0, 0, 4, 128),
                                      si.Point(100, 100, 0, 0, 4, 128)],
                              thickness_scale=1, starting_length=0))))
    out = io.BytesIO()
    write_blocks(out, blocks)
    return out.getvalue()


@unittest.skipUnless(HAS_CODEC, "optional rmscene and Pillow are not installed")
class Scratchpad(unittest.TestCase):
    notebook_id, other_id = uid(100), uid(200)
    p1, p2, p3 = uid(1), uid(2), uid(3)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "desktop"
        self.source.mkdir()
        self.output = self.root / "private" / "pages"
        self.ledger = self.root / "remarkable-filed.json"
        self.ledger.write_text('{"blog": "leave alone"}\n')
        patcher = mock.patch.object(rm, "LEDGER_FILE", self.ledger)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.content = self.notebook(self.notebook_id)

    def notebook(self, doc_id, name="scratchpad", **meta):
        write(self.source, doc_id, name, modified=1000, **meta)
        content = {"fileType": "notebook", "formatVersion": 2, "pageCount": 1,
                   "cPages": {"pages": [{"id": self.p1, "idx": {"value": "ba"}}]}}
        (self.source / doc_id).mkdir()
        (self.source / doc_id / f"{self.p1}.rm").write_bytes(page_bytes())
        self.save_content(content, doc_id)
        return content

    def save_content(self, content, doc_id=None):
        (self.source / f"{doc_id or self.notebook_id}.content").write_text(json.dumps(content))

    def update_meta(self, doc_id=None, **fields):
        path = self.source / f"{doc_id or self.notebook_id}.metadata"
        meta = json.loads(path.read_text())
        meta.update(fields)
        path.write_text(json.dumps(meta))

    def page(self, page_id=None):
        return self.source / self.notebook_id / f"{page_id or self.p1}.rm"

    def capture(self, notebook_id=None):
        return rm.capture_scratchpad(self.source, self.output, notebook_id)

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(rm, "SOURCE", self.source), \
                mock.patch.object(sys, "argv", ["remarkable.py", *args]), \
                mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr):
            rm.main()
        return stdout.getvalue(), stderr.getvalue()

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mtime_ns,
                                               stat.S_IMODE(p.stat().st_mode))
                for p in [*self.source.rglob("*"), self.ledger] if p.is_file()}

    def test_exact_case_insensitive_selection_ignores_other_content(self):
        self.update_meta(visibleName="ScRaTcHpAd")
        for n, name in enumerate(["work-meeting-notes", "scratchpad notes", " scratchpad"], 300):
            self.notebook(uid(n), name)
            (self.source / f"{uid(n)}.content").write_text("not readable")
        result = self.capture()
        self.assertEqual(result["notebookId"], self.notebook_id)
        self.assertEqual(result["name"], "ScRaTcHpAd")
        self.assertEqual(result["pages"][0]["text"], "typed text")

    def test_initial_duplicates_rejected_even_in_different_folders(self):
        write(self.source, uid(500), "elsewhere", kind="CollectionType")
        self.notebook(self.other_id, "SCRATCHPAD", parent=uid(500))
        with self.assertRaisesRegex(rm.CaptureError, "found 2"):
            self.capture()
        self.assertEqual(self.capture(self.notebook_id)["notebookId"], self.notebook_id)

    def test_pinned_uuid_survives_rename_without_switching_to_new_scratchpad(self):
        initial = self.capture()
        self.update_meta(visibleName="renamed", lastModified="9000")
        self.notebook(self.other_id)
        pinned = self.capture(initial["notebookId"])
        self.assertEqual(pinned["notebookId"], self.notebook_id)
        self.assertEqual(pinned["name"], "renamed")
        self.assertEqual(pinned["fingerprint"], initial["fingerprint"])
        self.assertEqual(self.capture()["notebookId"], self.other_id)

    def test_no_fallback_for_missing_or_deleted_pinned_uuid(self):
        self.notebook(self.other_id)
        with self.assertRaisesRegex(rm.CaptureError, "Pinned"):
            self.capture(uid(999))
        self.update_meta(deleted=True)
        with self.assertRaisesRegex(rm.CaptureError, "Pinned"):
            self.capture(self.notebook_id)

    def test_only_live_documents_are_selected(self):
        self.notebook(self.other_id, deleted=True)
        self.notebook(uid(300), parent="trash")
        write(self.source, uid(400), "scratchpad", kind="CollectionType")
        write(self.source, uid(500), "trashed folder", kind="CollectionType", parent="trash")
        self.notebook(uid(600), parent=uid(500))
        self.assertEqual(self.capture()["notebookId"], self.notebook_id)
        self.update_meta(visibleName="scratchpad extra")
        with self.assertRaisesRegex(rm.CaptureError, "found 0"):
            self.capture()

    def test_manifest_exact_schema_utc_timestamps_and_source_hashes(self):
        self.notebook(self.other_id, "unrelated")
        self.update_meta(self.other_id, lastModified="9001")
        result = self.capture()
        phash = hashlib.sha256(self.page().read_bytes()).hexdigest()
        nhash = hashlib.sha256(json.dumps([[self.p1, phash]], separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(result, {
            "version": 1, "notebookId": self.notebook_id, "name": "scratchpad",
            "sourceUpdatedAt": "1970-01-01T00:00:01.000Z",
            "newestChangeAt": "1970-01-01T00:00:09.001Z", "fingerprint": nhash,
            "pages": [{"id": self.p1, "number": 1, "fingerprint": phash, "text": "typed text"}]})

    def test_capture_preserves_typed_checkbox_states(self):
        from rmscene.scene_items import ParagraphStyle

        for style, marker in ((ParagraphStyle.CHECKBOX, "- [ ] "),
                              (ParagraphStyle.CHECKBOX_CHECKED, "- [x] ")):
            with self.subTest(style=style):
                self.page().write_bytes(page_bytes("Send draft", style=style))
                page = self.capture()["pages"][0]
                self.assertEqual(page["text"], marker + "Send draft")
                self.assertNotIn("reviewOnly", page)

    def test_writing_reader_keeps_existing_checkbox_output(self):
        from rmscene.scene_items import ParagraphStyle

        for style in (ParagraphStyle.CHECKBOX, ParagraphStyle.CHECKBOX_CHECKED):
            with self.subTest(style=style):
                data = page_bytes("Send draft", style=style)
                self.page().write_bytes(data)
                self.assertEqual(rm.read_page(self.page()), ("Send draft", []))
                self.assertEqual(rm.read_page(self.page(), data=data), ("Send draft", []))

    def test_mixed_page_is_review_only_with_full_text_and_png(self):
        text = "Send draft\nCheck the original tablet for cross-outs"
        data = page_bytes(text, ink=True)
        self.page().write_bytes(data)
        page = self.capture()["pages"][0]
        self.assertIs(page["reviewOnly"], True)
        self.assertEqual(page["text"], text)
        self.assertTrue(Path(page["image"]).read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(page["fingerprint"], hashlib.sha256(data).hexdigest())
        self.assertEqual(set(page), {"id", "number", "fingerprint", "text", "image", "reviewOnly"})

    def test_pure_typed_ink_and_blank_pages_omit_review_only(self):
        for text, ink in (("typed text", False), ("", True), ("", False)):
            with self.subTest(text=text, ink=ink):
                self.page().write_bytes(page_bytes(text, ink=ink))
                page = self.capture()["pages"][0]
                self.assertEqual(page["text"], text)
                self.assertNotIn("reviewOnly", page)
                self.assertEqual("image" in page, ink)

    def test_true_reading_order_and_lww_live_deleted_flags(self):
        self.content["cPages"]["pages"] = [
            {"id": self.p2, "idx": {"value": "bb"}, "deleted": {"value": 0}},
            {"id": self.p3, "idx": {"value": "ba"}, "deleted": {"value": 1}},
            {"id": self.p1, "idx": {"value": "bab"}}]
        self.content["pageCount"] = 2
        self.save_content(self.content)
        result = self.capture()
        self.assertEqual([(p["id"], p["number"]) for p in result["pages"]],
                         [(self.p1, 1), (self.p2, 2)])
        self.assertEqual(result["pages"][1]["text"], "")

    def test_legacy_pages_stay_in_list_order_including_blank(self):
        self.save_content({"fileType": "notebook", "pages": [self.p2, self.p1]})
        self.assertEqual([p["id"] for p in self.capture()["pages"]], [self.p2, self.p1])

    def test_byte_changes_not_metadata_change_fingerprints(self):
        initial = self.capture()
        self.update_meta(visibleName="rename", lastModified="123456")
        self.content["cPages"]["pages"][0]["modifed"] = "123456"
        self.save_content(self.content)
        unchanged = self.capture(self.notebook_id)
        self.assertEqual(initial["fingerprint"], unchanged["fingerprint"])
        self.page().write_bytes(page_bytes("new text"))
        changed = self.capture(self.notebook_id)
        self.assertNotEqual(unchanged["fingerprint"], changed["fingerprint"])
        self.assertNotEqual(unchanged["pages"][0]["fingerprint"], changed["pages"][0]["fingerprint"])
        self.assertEqual(changed["pages"][0]["text"], "new text")

    def test_reorder_deletion_and_blank_addition_change_notebook_fingerprint(self):
        initial = self.capture()
        self.content["cPages"]["pages"].append({"id": self.p2, "idx": {"value": "bb"}})
        self.content["pageCount"] = 2
        self.save_content(self.content)
        added = self.capture()
        self.assertNotEqual(added["fingerprint"], initial["fingerprint"])
        self.content["cPages"]["pages"][1]["idx"]["value"] = "a"
        self.save_content(self.content)
        reordered = self.capture()
        self.assertNotEqual(added["fingerprint"], reordered["fingerprint"])
        self.assertEqual(added["pages"][1]["fingerprint"], reordered["pages"][0]["fingerprint"])
        self.content["cPages"]["pages"][1]["deleted"] = True
        self.content["pageCount"] = 1
        self.save_content(self.content)
        self.assertEqual(self.capture()["fingerprint"], initial["fingerprint"])

    def test_untouched_missing_page_is_included_with_stable_empty_byte_hash(self):
        self.page().unlink()
        initial = self.capture()
        self.assertEqual(initial["pages"], [{"id": self.p1, "number": 1, "text": "",
                                          "fingerprint": hashlib.sha256(b"").hexdigest()}])
        self.assertEqual(initial, self.capture())
        self.assertEqual(list(self.output.iterdir()), [])

    def test_blank_rm_file_is_decoded_not_skipped(self):
        self.page().write_bytes(page_bytes(""))
        result = self.capture()
        self.assertEqual(result["pages"][0]["text"], "")
        self.assertEqual(result["pages"][0]["fingerprint"], hashlib.sha256(self.page().read_bytes()).hexdigest())
        self.assertNotIn("image", result["pages"][0])

    def test_missing_edited_page_fails_for_both_timestamp_spellings(self):
        self.page().unlink()
        for spelling in ("modifed", "modified"):
            with self.subTest(spelling=spelling):
                content = copy.deepcopy(self.content)
                content["cPages"]["pages"][0][spelling] = "1000"
                self.save_content(content)
                with self.assertRaisesRegex(rm.CaptureError, "Missing content"):
                    self.capture()

    def test_missing_page_with_sidecar_or_declared_content_bytes_fails(self):
        self.page().unlink()
        sidecar = self.page().with_suffix(".json")
        sidecar.write_text("{}")
        with self.assertRaisesRegex(rm.CaptureError, "Missing content"):
            self.capture()
        sidecar.unlink()
        self.content["sizeInBytes"] = "100"
        self.save_content(self.content)
        with self.assertRaisesRegex(rm.CaptureError, "content bytes"):
            self.capture()

    def test_source_and_blog_ledger_unchanged_and_no_old_workflow_called(self):
        self.page().write_bytes(page_bytes(ink=True))
        before = self.snapshot()
        with mock.patch.object(rm, "load_index", side_effect=AssertionError("writing read")), \
                mock.patch.object(rm, "load_ledger", side_effect=AssertionError("ledger read")), \
                mock.patch.object(rm, "record_filed", side_effect=AssertionError("ledger write")):
            stdout, stderr = self.run_cli("--capture-scratchpad", "--output-dir", str(self.output))
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["notebookId"], self.notebook_id)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(rm.PAGES_DIR in self.output.parents)

    def test_private_images_are_absolute_unique_and_stable(self):
        self.page().write_bytes(page_bytes(ink=True))
        result = self.capture()
        page = result["pages"][0]
        image = Path(page["image"])
        self.assertTrue(image.is_absolute())
        self.assertEqual(image.parent, self.output.resolve())
        self.assertEqual(image.name, f"{self.notebook_id}-{self.p1}-{page['fingerprint']}.png")
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(image.stat().st_mode), 0o600)
        self.assertTrue(image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(result, self.capture())
        self.page().write_bytes(page_bytes("changed", ink=True))
        self.assertNotEqual(self.capture()["pages"][0]["image"], str(image))
        self.assertEqual(len(list(self.output.iterdir())), 2)

    def test_image_is_private_during_render_and_existing_output_is_restricted(self):
        self.output.mkdir(parents=True, mode=0o755)
        self.output.chmod(0o755)
        self.page().write_bytes(page_bytes(ink=True))
        renderer = rm.render_png

        def check(strokes, path):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            return renderer(strokes, path)

        with mock.patch.object(rm, "render_png", side_effect=check):
            self.capture()

    def test_render_failure_cleans_temporary_image(self):
        self.page().write_bytes(page_bytes(ink=True))
        with mock.patch.object(rm, "render_png", side_effect=ValueError("bad stroke")), \
                self.assertRaisesRegex(rm.CaptureError, "Cannot render"):
            self.capture()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_malformed_metadata_fails_instead_of_hiding_duplicates(self):
        path = self.source / f"{self.other_id}.metadata"
        for data in ("{", "[]", "null", "{}", '{"type":1,"type":2}', '{"bad":NaN}'):
            with self.subTest(data=data):
                path.write_text(data)
                with self.assertRaises(rm.CaptureError):
                    self.capture()

    def test_bad_metadata_fields_and_parent_graph_fail_closed(self):
        path = self.source / f"{self.notebook_id}.metadata"
        original = path.read_bytes()
        for fields in ({"lastModified": None}, {"lastModified": "NaN"},
                       {"lastModified": -1}, {"lastModified": True}, {"lastModified": "9" * 30},
                       {"visibleName": None}, {"type": "invalid"}, {"deleted": "false"},
                       {"parent": uid(999)}, {"parent": self.notebook_id}):
            with self.subTest(fields=fields):
                path.write_bytes(original)
                self.update_meta(**fields)
                with self.assertRaises(rm.CaptureError):
                    self.capture()

    def test_missing_or_malformed_content_fails_closed(self):
        path = self.source / f"{self.notebook_id}.content"
        path.unlink()
        with self.assertRaises(rm.CaptureError):
            self.capture()
        for value in ("{", "null", "[]", "{}"):
            with self.subTest(value=value):
                path.write_text(value)
                with self.assertRaises(rm.CaptureError):
                    self.capture()

    def test_bad_content_schema_and_page_ids_fail_closed(self):
        bad = [
            {"fileType": "pdf", "pages": []},
            {"fileType": "notebook", "pages": None},
            {"fileType": "notebook", "pages": "not a list"},
            {"fileType": "notebook", "pages": ["../outside"]},
            {"fileType": "notebook", "pages": [self.p1, self.p1]},
            {"fileType": "notebook", "pages": [self.p1], "formatVersion": 99},
            {"fileType": "notebook", "pages": [self.p1], "formatVersion": True},
            {"fileType": "notebook", "cPages": None},
            {"fileType": "notebook", "cPages": {"pages": None}},
            {"fileType": "notebook", "cPages": {"pages": [None]}},
            {"fileType": "notebook", "cPages": {"pages": [{"id": self.p1}]}},
            {"fileType": "notebook", "cPages": {"pages": [{"id": "../outside", "idx": {"value": "a"}}]}},
            {"fileType": "notebook", "cPages": {"pages": [{"id": self.p1, "idx": {"value": "a"}},
                                                          {"id": self.p2, "idx": {"value": "a"}}]}},
            {**self.content, "pageCount": 2},
            {**self.content, "pageCount": True},
        ]
        for content in bad:
            with self.subTest(content=content):
                self.save_content(content)
                with self.assertRaises(rm.CaptureError):
                    self.capture()

    def test_valid_explicit_empty_page_list_is_not_missing_content(self):
        self.save_content({"fileType": "notebook", "pages": [], "pageCount": 0})
        self.assertEqual(self.capture()["pages"], [])

    def test_corrupt_unsupported_or_truncated_rm_is_never_empty(self):
        from rmscene import HEADER_V6
        original = self.page().read_bytes()
        for data in (b"", b"not rm", HEADER_V6, original[:-1], original + b"\x01",
                     HEADER_V6 + struct.pack("<IBBBB", 1, 0, 1, 1, 255) + b"x",
                     HEADER_V6 + struct.pack("<IBBBB", 1, 0, 1, 1, 7) + b"x"):
            with self.subTest(length=len(data)):
                self.page().write_bytes(data)
                with self.assertRaisesRegex(rm.CaptureError, "Cannot decode"):
                    self.capture()

    def test_unread_content_extension_and_duplicate_root_text_fail(self):
        from rmscene import RootTextBlock, read_blocks, write_blocks
        blocks = list(read_blocks(io.BytesIO(self.page().read_bytes())))
        text = next(b for b in blocks if isinstance(b, RootTextBlock))
        for malformed in ([*blocks, text], [*blocks[:-1], copy.deepcopy(blocks[-1])]):
            if len(malformed) == len(blocks):
                malformed[-1].extra_data = b"unsupported content"
            out = io.BytesIO()
            write_blocks(out, malformed)
            self.page().write_bytes(out.getvalue())
            with self.assertRaises(rm.CaptureError):
                self.capture()

    def test_view_metadata_extension_does_not_hide_real_content(self):
        from rmscene import (
            CrdtId,
            LwwValue,
            SceneInfo,
            simple_text_document,
            write_blocks,
        )
        out = io.BytesIO()
        blocks = list(simple_text_document("still readable", author_uuid=UUID(int=1)))
        blocks.append(SceneInfo(current_layer=LwwValue(CrdtId(1, 1), CrdtId(0, 11)),
                                background_visible=LwwValue(CrdtId(1, 2), True),
                                root_document_visible=LwwValue(CrdtId(1, 3), True),
                                extra_data=b"view settings"))
        write_blocks(out, blocks)
        self.page().write_bytes(out.getvalue())
        self.assertEqual(self.capture()["pages"][0]["text"], "still readable")

    def test_unsafe_notebook_ids_rejected(self):
        for doc_id in ("../escape", "/absolute", "not-a-uuid", "", "a" * 36):
            with self.subTest(doc_id=doc_id), self.assertRaises(rm.CaptureError):
                self.capture(doc_id)
        (self.source / "unsafe.metadata").write_text("{}")
        with self.assertRaises(rm.CaptureError):
            self.capture()

    def test_unsafe_source_overlap_and_alias_output_locations_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        for output in (self.source, self.source / "export", self.root, alias, alias / "export"):
            with self.subTest(output=output), self.assertRaises(rm.CaptureError):
                rm.capture_scratchpad(self.source, output)
        self.assertFalse((self.source / "export").exists())

    def test_source_metadata_content_and_page_symlinks_rejected(self):
        for path in (self.source / f"{self.notebook_id}.metadata",
                     self.source / f"{self.notebook_id}.content", self.page()):
            with self.subTest(path=path):
                original = path.read_bytes()
                outside = self.root / "outside"
                outside.write_bytes(original)
                path.unlink()
                path.symlink_to(outside)
                with self.assertRaises(rm.CaptureError):
                    self.capture()
                path.unlink()
                path.write_bytes(original)

    def test_dangling_page_symlink_is_not_an_untouched_blank(self):
        self.page().unlink()
        self.page().symlink_to(self.root / "missing")
        with self.assertRaises(rm.CaptureError):
            self.capture()

    def test_notebook_directory_symlink_and_non_directory_fail(self):
        directory = self.source / self.notebook_id
        moved = self.root / "moved"
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(rm.CaptureError):
            self.capture()
        directory.unlink()
        directory.write_text("not a directory")
        with self.assertRaises(rm.CaptureError):
            self.capture()

    def test_image_symlink_cannot_modify_source_or_ledger(self):
        self.page().write_bytes(page_bytes(ink=True))
        image = Path(self.capture()["pages"][0]["image"])
        image.unlink()
        image.symlink_to(self.ledger)
        before = self.snapshot()
        with self.assertRaises(rm.CaptureError):
            self.capture()
        self.assertEqual(before, self.snapshot())

    def test_cli_pinned_rename_emits_only_manifest(self):
        self.update_meta(visibleName="renamed")
        stdout, stderr = self.run_cli("--capture-scratchpad", "--output-dir", str(self.output),
                                      "--notebook-id", self.notebook_id)
        self.assertEqual(json.loads(stdout)["name"], "renamed")
        self.assertEqual(stderr, "")

    def test_cli_requires_explicit_mode_output_and_no_writing_flags(self):
        cases = [("--capture-scratchpad",), ("--output-dir", str(self.output)),
                 ("--notebook-id", self.notebook_id)]
        cases += [("--capture-scratchpad", "--output-dir", str(self.output), *flag)
                  for flag in (("--text", "optimism"), ("--count",), ("--filed", "a=b"))]
        for args in cases:
            with self.subTest(args=args):
                with self.assertRaises(SystemExit) as ctx:
                    self.run_cli(*args)
                self.assertEqual(ctx.exception.code, 2)
        self.assertFalse(self.output.exists())

    def test_cli_failure_prints_no_manifest_and_exits_nonzero(self):
        self.page().write_bytes(b"bad data")
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(rm, "SOURCE", self.source), \
                mock.patch.object(sys, "argv", ["remarkable.py", "--capture-scratchpad",
                                                "--output-dir", str(self.output)]), \
                mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr), \
                self.assertRaises(SystemExit) as ctx:
            rm.main()
        self.assertEqual(ctx.exception.code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("Scratchpad capture failed:", stderr.getvalue())
        self.assertFalse(self.output.exists())


class StdlibCapture(unittest.TestCase):
    """Capture boundaries independent of the optional page codec and renderer."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "synthetic-desktop"
        self.source.mkdir()
        self.output = self.root / "private-pages"
        self.notebook_id, self.page_id = uid(100), uid(1)
        write(self.source, self.notebook_id, "Synthetic Notebook")
        self.content = {"fileType": "notebook", "pages": [self.page_id], "pageCount": 1}
        self.content_path = self.source / f"{self.notebook_id}.content"
        self.content_path.write_text(json.dumps(self.content))
        (self.source / self.notebook_id).mkdir()
        self.page = self.source / self.notebook_id / f"{self.page_id}.rm"
        self.page.write_bytes(b"synthetic bytes, not notebook data")
        decoder = mock.patch.object(rm, "read_page", return_value=("Synthetic text", []))
        self.decode = decoder.start()
        self.addCleanup(decoder.stop)

    def capture(self, **kwargs):
        return rm.capture_scratchpad(self.source, self.output, notebook_name="Synthetic Notebook", **kwargs)

    def test_custom_name_exact_match_and_source_bytes_unchanged(self):
        before = {p: p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        manifest = self.capture()
        self.assertEqual(manifest["name"], "Synthetic Notebook")
        self.assertEqual(manifest["pages"][0]["text"], "Synthetic text")
        self.assertEqual(manifest["pages"][0]["fingerprint"], hashlib.sha256(self.page.read_bytes()).hexdigest())
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.decode.assert_called_once_with(self.page.resolve(), data=self.page.read_bytes(), strict=True)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)

    def test_custom_name_case_insensitive_and_no_default_fallback(self):
        manifest = rm.capture_scratchpad(self.source, self.output, notebook_name="sYnThEtIc NoTeBoOk")
        self.assertEqual(manifest["notebookId"], self.notebook_id)
        with self.assertRaisesRegex(rm.CaptureError, "found 0"):
            rm.capture_scratchpad(self.source, self.output)

    def test_duplicate_names_rejected_but_pinned_id_survives_rename(self):
        write(self.source, uid(200), "Synthetic Notebook")
        with self.assertRaisesRegex(rm.CaptureError, "found 2"):
            self.capture()
        manifest = self.capture(notebook_id=self.notebook_id)
        self.assertEqual(manifest["notebookId"], self.notebook_id)
        write(self.source, self.notebook_id, "Renamed synthetic notebook")
        self.assertEqual(self.capture(notebook_id=self.notebook_id)["name"], "Renamed synthetic notebook")

    def test_missing_pinned_id_never_falls_back(self):
        with self.assertRaisesRegex(rm.CaptureError, "Pinned"):
            self.capture(notebook_id=uid(999))

    def test_missing_edited_page_rejected_and_untouched_blank_retained(self):
        self.page.unlink()
        self.assertEqual(self.capture()["pages"][0]["text"], "")
        self.content_path.write_text(json.dumps({"fileType": "notebook", "formatVersion": 2,
            "cPages": {"pages": [{"id": self.page_id, "idx": {"value": "a"}, "modified": "1000"}]}}))
        with self.assertRaisesRegex(rm.CaptureError, "Missing content"):
            self.capture()

    def test_invalid_json_and_duplicate_keys_fail_closed(self):
        for value in ("{", "null", '{"fileType":"notebook","fileType":"pdf"}', '{"bad":NaN}'):
            with self.subTest(value=value):
                self.content_path.write_text(value)
                with self.assertRaises(rm.CaptureError):
                    self.capture()

    def test_path_traversal_and_source_symlinks_rejected(self):
        self.content_path.write_text(json.dumps({"fileType": "notebook", "pages": ["../outside"]}))
        with self.assertRaises(rm.CaptureError):
            self.capture()
        self.content_path.write_text(json.dumps(self.content))
        outside = self.root / "outside"
        outside.write_bytes(self.page.read_bytes())
        self.page.unlink()
        self.page.symlink_to(outside)
        with self.assertRaises(rm.CaptureError):
            self.capture()

    def test_output_overlap_rejected(self):
        for output in (self.source, self.source / "export", self.root):
            with self.subTest(output=output), self.assertRaises(rm.CaptureError):
                rm.capture_scratchpad(self.source, output, notebook_name="Synthetic Notebook")

    def test_mocked_images_are_private_and_render_failure_is_clean(self):
        self.decode.return_value = ("Synthetic text", [object()])
        def render(_strokes, path):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            path.write_bytes(b"synthetic PNG placeholder")
        with mock.patch.object(rm, "render_png", side_effect=render):
            page = self.capture()["pages"][0]
        self.assertTrue(page["reviewOnly"])
        self.assertEqual(stat.S_IMODE(Path(page["image"]).stat().st_mode), 0o600)
        Path(page["image"]).unlink()
        with mock.patch.object(rm, "render_png", side_effect=ValueError("synthetic failure")):
            with self.assertRaisesRegex(rm.CaptureError, "Cannot render"):
                self.capture()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_cli_source_name_and_pin_propagation(self):
        stdout = io.StringIO()
        argv = ["remarkable.py", "--capture-scratchpad", "--source", str(self.source),
                "--notebook-name", "Synthetic Notebook", "--output-dir", str(self.output),
                "--notebook-id", self.notebook_id]
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stdout", stdout), \
                mock.patch.object(rm, "load_index", side_effect=AssertionError("unrelated folder read")), \
                mock.patch.object(rm, "load_ledger", side_effect=AssertionError("ledger read")):
            rm.main()
        self.assertEqual(json.loads(stdout.getvalue())["notebookId"], self.notebook_id)

    def test_missing_source_does_not_block_other_helpers_or_create_output(self):
        with self.assertRaises(OSError):
            rm.capture_scratchpad(self.root / "missing", self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
