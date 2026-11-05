# /// script
# requires-python = ">=3.10"
# dependencies = ["rmscene==0.6.1", "pillow"]
# ///
"""Read notebooks from a local reMarkable desktop copy.

The reMarkable desktop app keeps a full copy of the tablet on this Mac. This
script reads the notebooks in one folder (`FOLDER`) from that copy, so there is
no cloud login and no API to break. It never writes there: nothing on the
tablet is ever renamed, moved or deleted. Filing records, when explicitly
requested, update only the local ledger.

A page holds typed text, handwriting, or both. Typed text comes out as
markdown. Handwriting is drawn to a PNG for Claude to read, because the
files hold pen strokes, not letters.

The ledger is machine-local and gitignored. It records where each notebook was
filed and how it looked then, so a notebook edited on the tablet afterwards is
offered again.

The copy is only as fresh as the desktop app's last sync. The listing prints
the newest change it holds, so a stale copy shows.

Usage:
    uv run helpers/remarkable.py --source /path/to/desktop --count
    uv run helpers/remarkable.py --source /path/to/desktop --capture-scratchpad \\
        --notebook-name Scratchpad --output-dir /private/capture-pages
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import stat
import tempfile
from pathlib import Path

SOURCE = (Path.home() / "Library/Containers/com.remarkable.desktop/Data/Library"
          / "Application Support/remarkable/desktop")
FOLDER = "writing"
CACHE_HOME = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
if not CACHE_HOME.is_absolute():
    raise ValueError("XDG_CACHE_HOME must be absolute")
CACHE = CACHE_HOME / "pi-extensions" / "remarkable"
LEDGER_FILE = CACHE / "remarkable-filed.json"
PAGES_DIR = CACHE / "remarkable-pages"


def stamp(ms: int) -> str:
    return f"{dt.datetime.fromtimestamp(ms / 1000):%Y-%m-%d %H:%M}"


# --------------------------------------------------------------------------
# The desktop app's copy
# --------------------------------------------------------------------------


def load_metadata(source: Path) -> dict[str, dict]:
    out = {}
    for path in source.glob("*.metadata"):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not meta.get("deleted") and meta.get("parent") != "trash":
            out[path.stem] = meta
    return out


def page_files(source: Path, doc_id: str) -> list[Path]:
    """The notebook's pages in reading order. A page never drawn on has no file."""
    try:
        content = json.loads((source / f"{doc_id}.content").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    pages = content.get("cPages", {}).get("pages")
    if pages is not None:
        # Format 2 orders pages by a fractional index string, not by list position.
        live = [p for p in pages if not p.get("deleted")]
        ids = [p["id"] for p in sorted(live, key=lambda p: p.get("idx", {}).get("value", ""))]
    else:
        ids = content.get("pages") or []
    return [f for f in (source / doc_id / f"{i}.rm" for i in ids) if f.exists()]


def load_index(source: Path = SOURCE, folder: str = FOLDER) -> tuple[list[dict], int]:
    """Notebooks in `folder`, and the newest change anywhere in the copy."""
    if not source.is_dir():
        raise SystemExit(f"No reMarkable desktop copy at {source}.\n"
                         "Install the reMarkable desktop app and sign in once.")
    meta = load_metadata(source)
    folders = {k for k, m in meta.items()
               if m.get("type") == "CollectionType" and m.get("visibleName") == folder}
    if not folders:
        raise SystemExit(f"No folder {folder!r} in the reMarkable copy.")
    docs = [{"id": k, "name": m.get("visibleName", k), "modified": int(m.get("lastModified", 0)),
             "pages": page_files(source, k)}
            for k, m in meta.items()
            if m.get("type") == "DocumentType" and m.get("parent") in folders]
    newest = max((int(m.get("lastModified", 0)) for m in meta.values()), default=0)
    return docs, newest


def keyed(docs: list[dict]) -> dict[str, dict]:
    """Short handles for the command line. Notebook names are slugs already."""
    out: dict[str, dict] = {}
    for doc in sorted(docs, key=lambda d: d["modified"]):
        base = re.sub(r"[^a-z0-9]+", "-", doc["name"].lower()).strip("-") or "notebook"
        key, n = base, 2
        while key in out:
            key, n = f"{base}-{n}", n + 1
        out[key] = doc
    return out


# --------------------------------------------------------------------------
# Ledger
# --------------------------------------------------------------------------


def load_ledger() -> dict[str, dict]:
    try:
        return json.loads(LEDGER_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def waiting(handles: dict[str, dict], ledger: dict[str, dict]) -> list[tuple[str, dict, bool]]:
    """(key, notebook, changed) for every notebook not filed as it is now."""
    out = []
    for key, doc in handles.items():
        filed = ledger.get(doc["id"])
        if filed is None:
            out.append((key, doc, False))
        elif filed.get("modified", 0) < doc["modified"]:
            out.append((key, doc, True))
    return sorted(out, key=lambda item: item[1]["modified"], reverse=True)


def record_filed(pairs: dict[str, str], handles: dict[str, dict]) -> list[str]:
    ledger, done = load_ledger(), []
    for key, where in pairs.items():
        doc = handles.get(key)
        if doc is None:
            raise SystemExit(f"No notebook {key!r} in {FOLDER}.")
        ledger[doc["id"]] = {"filed": dt.date.today().isoformat(), "where": where,
                             "title": doc["name"], "modified": doc["modified"]}
        done.append(f"{doc['name']} -> {where}")
    LEDGER_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    LEDGER_FILE.parent.chmod(0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=LEDGER_FILE.parent,
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(ledger, indent=1, ensure_ascii=False) + "\n")
        os.replace(temporary, LEDGER_FILE)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return done


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------


def read_page(path: Path, *, data: bytes | None = None, strict: bool = False) -> tuple[str, list]:
    """(typed text as markdown, pen strokes). Either may be empty.

    Capture supplies the exact bytes it hashed and rejects unsupported/damaged
    blocks. The original writing-folder reader keeps its existing behaviour.
    """
    from rmscene import read_tree
    from rmscene import scene_items as si
    from rmscene.text import TextDocument

    if strict:
        tree = capture_tree(path.read_bytes() if data is None else data)
    elif data is not None:
        tree = read_tree(io.BytesIO(data))
    else:
        with path.open("rb") as f:
            tree = read_tree(f)
    text = ""
    if tree.root_text is not None:
        prefix = {si.ParagraphStyle.HEADING: "# ", si.ParagraphStyle.BULLET: "- ",
                  si.ParagraphStyle.BULLET2: "  - "}
        if strict:
            prefix.update({si.ParagraphStyle.CHECKBOX: "- [ ] ",
                           si.ParagraphStyle.CHECKBOX_CHECKED: "- [x] "})
        doc = TextDocument.from_scene_item(tree.root_text)
        text = "\n".join(prefix.get(p.style.value, "") + str(p).rstrip("\n")
                         for p in doc.contents).strip()
    erasers = {si.Pen.ERASER, si.Pen.ERASER_AREA}
    strokes = [item for item in tree.walk()
               if isinstance(item, si.Line) and item.points and item.tool not in erasers]
    return text, strokes


def render_png(strokes: list, out: Path, margin: int = 40) -> Path:
    """Draw the strokes black on white, cropped to the ink. Enough to read, no more.

    Direct drawing rather than rmc's SVG export: ImageMagick's SVG renderer
    fails on the font rmc writes for typed text.
    """
    from PIL import Image, ImageDraw

    xs = [p.x for s in strokes for p in s.points]
    ys = [p.y for s in strokes for p in s.points]
    x0, y0 = min(xs) - margin, min(ys) - margin
    img = Image.new("L", (int(max(xs) - x0 + margin), int(max(ys) - y0 + margin)), 255)
    draw = ImageDraw.Draw(img)
    for s in strokes:
        pts = [(p.x - x0, p.y - y0) for p in s.points]
        if len(pts) == 1:
            pts = pts * 2
        draw.line(pts, fill=0, width=3, joint="curve")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out


def print_text(keys: list[str], handles: dict[str, dict]) -> None:
    missing = [k for k in keys if k not in handles]
    if missing:
        raise SystemExit(f"No notebook {', '.join(missing)} in {FOLDER}.")
    for key in keys:
        doc = handles[key]
        print(f"## {key} · {doc['name']} · modified {stamp(doc['modified'])} · "
              f"{len(doc['pages'])} pages\n")
        for n, page in enumerate(doc["pages"], 1):
            text, strokes = read_page(page)
            if text:
                print(text + "\n")
            if strokes:
                PAGES_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
                PAGES_DIR.chmod(0o700)
                png = capture_image(strokes, PAGES_DIR, f"{key}-{n}.png")
                print(f"[handwriting, page {n}: read {png}]\n")


# --------------------------------------------------------------------------
# Explicit scratchpad capture. No writing-folder defaults or ledger access.
# --------------------------------------------------------------------------


class CaptureError(ValueError):
    """An ambiguous or unsafe desktop snapshot must not become a manifest."""


def capture_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value
    ):
        raise CaptureError(f"Invalid source UUID: {value!r}")
    return value


def capture_path(source: Path, *parts: str) -> Path:
    """Source paths may not traverse links, including dangling links."""
    path = source
    for part in parts:
        path = path / part
        if path.is_symlink() or not path.resolve().is_relative_to(source):
            raise CaptureError(f"Unsafe source path: {path}")
    return path


def capture_json(path: Path) -> dict:
    def unique_object(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise CaptureError(f"Duplicate JSON key: {key}")
            out[key] = value
        return out

    def invalid_constant(value):
        raise CaptureError(f"Invalid JSON constant: {value}")

    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                           parse_constant=invalid_constant)
    except (OSError, ValueError) as exc:
        raise CaptureError(f"Cannot read {path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise CaptureError(f"Expected an object in {path.name}")
    return value


def capture_milliseconds(value) -> int:
    if (type(value) is not int and not (isinstance(value, str) and value.isascii()
                                       and value.isdecimal())) or int(value) < 0:
        raise CaptureError(f"Invalid lastModified timestamp: {value!r}")
    ms = int(value)
    try:
        dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)
    except (ValueError, OverflowError, OSError) as exc:
        raise CaptureError(f"Invalid timestamp: {value!r}") from exc
    return ms


def capture_iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def capture_deleted(value=False) -> bool:
    # cPages uses an LWW register. A register whose value is zero is live.
    if isinstance(value, dict):
        if "value" not in value:
            raise CaptureError("Missing deleted register value")
        value = value["value"]
    if type(value) not in (bool, int) or value not in (False, True):
        raise CaptureError(f"Invalid deleted flag: {value!r}")
    return bool(value)


def capture_index(source: Path, notebook_id: str | None, notebook_name: str = "Scratchpad") -> tuple[str, dict, int]:
    metadata = {}
    for path in source.glob("*.metadata"):
        doc_id = capture_id(path.stem)
        meta = capture_json(capture_path(source, path.name))
        if (meta.get("type") not in ("CollectionType", "DocumentType")
                or not isinstance(meta.get("visibleName"), str)
                or not isinstance(meta.get("parent"), str)):
            raise CaptureError(f"Malformed metadata: {path.name}")
        capture_milliseconds(meta.get("lastModified"))
        capture_deleted(meta.get("deleted", False))
        metadata[doc_id] = meta

    def live(doc_id: str) -> bool:
        seen = set()
        while doc_id:
            if doc_id == "trash":
                return False
            if doc_id in seen or doc_id not in metadata:
                raise CaptureError("Missing or cyclic notebook parent metadata")
            seen.add(doc_id)
            meta = metadata[doc_id]
            if capture_deleted(meta.get("deleted", False)):
                return False
            parent = meta["parent"]
            if parent not in ("", "trash") and metadata.get(parent, {}).get("type") != "CollectionType":
                raise CaptureError("Notebook parent is not a collection")
            doc_id = parent
        return True

    live_ids = {doc_id for doc_id in metadata if live(doc_id)}
    if notebook_id is None:
        matches = [doc_id for doc_id in live_ids
                   if metadata[doc_id]["type"] == "DocumentType"
                   and metadata[doc_id]["visibleName"].casefold() == notebook_name.casefold()]
        if len(matches) != 1:
            raise CaptureError(f"Expected one live notebook named {notebook_name!r}, found {len(matches)}")
        notebook_id = matches[0]
    else:
        capture_id(notebook_id)
    if notebook_id not in live_ids or metadata[notebook_id]["type"] != "DocumentType":
        raise CaptureError("Pinned notebook is missing, deleted or not a notebook")
    newest = max(capture_milliseconds(metadata[i]["lastModified"]) for i in live_ids)
    return notebook_id, metadata[notebook_id], newest


def capture_pages(content: dict) -> list[dict]:
    if content.get("fileType") != "notebook":
        raise CaptureError("Capture requires a notebook, not a PDF or EPUB")
    if "cPages" in content:
        version = content.get("formatVersion", 2)
        if type(version) is not int or version != 2 or not isinstance(content["cPages"], dict):
            raise CaptureError("Unsupported notebook content format")
        pages = content["cPages"].get("pages")
        if not isinstance(pages, list) or any(not isinstance(p, dict) for p in pages):
            raise CaptureError("Missing or malformed cPages page list")
        ids = [capture_id(p.get("id")) for p in pages]
        live = [p for p in pages if not capture_deleted(p.get("deleted", False))]
        indices = [p.get("idx", {}).get("value") if isinstance(p.get("idx"), dict)
                   else None for p in live]
        if (any(not isinstance(i, str) or not i for i in indices)
                or len(set(indices)) != len(indices)):
            raise CaptureError("Missing or ambiguous page reading order")
        live = sorted(live, key=lambda p: p["idx"]["value"])
    else:
        version = content.get("formatVersion", 1)
        if type(version) is not int or version != 1 or not isinstance(content.get("pages"), list):
            raise CaptureError("Missing or unsupported notebook page list")
        ids = [capture_id(p) for p in content["pages"]]
        live = [{"id": p} for p in ids]
    if len(set(ids)) != len(ids):
        raise CaptureError("Duplicate source page UUID")
    if "pageCount" in content and (type(content["pageCount"]) is not int
                                    or content["pageCount"] != len(live)):
        raise CaptureError("pageCount does not match live pages")
    return live


def capture_tree(data: bytes):
    """rmscene normally skips unreadable blocks. Capture must reject them."""
    from rmscene import (
        Block,
        MainBlockInfo,
        RootTextBlock,
        SceneGlyphItemBlock,
        SceneInfo,
        SceneTextItemBlock,
        SceneTreeBlock,
        TaggedBlockReader,
        UnreadableBlock,
        build_tree,
    )
    from rmscene.scene_tree import SceneTree

    class StrictReader(TaggedBlockReader):
        def _check_position(self, block_info):
            end = block_info.offset + block_info.size
            if (isinstance(block_info, MainBlockInfo)
                    and block_info.block_type == SceneInfo.BLOCK_TYPE
                    and self.data.tell() < end):
                # Current desktops append view settings to SceneInfo. They do
                # not contain ink/text. Still require the full declared bytes.
                block_info.extra_data = self.data.read_bytes(end - self.data.tell())
            elif self.data.tell() != end:
                raise CaptureError("Unread or truncated page block content")

        def read_string_with_format(self, index):
            text, fmt = super().read_string_with_format(index)
            if text and fmt is not None:
                raise CaptureError("Unsupported combined text and formatting")
            return text, fmt

    stream = io.BytesIO(data)
    reader = StrictReader(stream)
    reader.read_header()
    blocks = []
    while stream.tell() < len(data):
        if len(data) - stream.tell() < 8:
            raise CaptureError("Truncated page block header")
        block = Block.read(reader)
        if block is None or isinstance(block, (UnreadableBlock, SceneGlyphItemBlock, SceneTextItemBlock)):
            raise CaptureError("Unsupported or unreadable page block")
        blocks.append(block)
    if (not any(isinstance(b, (SceneTreeBlock, RootTextBlock)) for b in blocks)
            or sum(isinstance(b, RootTextBlock) for b in blocks) > 1):
        raise CaptureError("Missing or ambiguous page content")
    tree = SceneTree()
    build_tree(tree, blocks)
    return tree


def capture_output_dir(source: Path, output_dir: Path) -> Path:
    if output_dir.is_symlink():
        raise CaptureError("Output directory must not be a symlink")
    output = output_dir.resolve()
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise CaptureError("Output directory must not overlap the desktop source")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.chmod(0o700)
    return output


def capture_image(strokes: list, output: Path, filename: str) -> str:
    target = output / filename
    if target.is_symlink() or (target.exists() and not stat.S_ISREG(target.stat().st_mode)):
        raise CaptureError(f"Unsafe output image: {target}")
    # Render into a 0600 temporary file, then replace rather than follow links.
    # Even while being rendered, ink is never world-readable.
    with tempfile.NamedTemporaryFile(dir=output, suffix=".png", delete=False) as f:
        tmp = Path(f.name)
    try:
        render_png(strokes, tmp)
        tmp.chmod(0o600)
        os.replace(tmp, target)
    except Exception as exc:
        raise CaptureError(f"Cannot render capture image: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)
    return str(target)


def capture_scratchpad(source: Path, output_dir: Path, notebook_id: str | None = None,
                       notebook_name: str = "Scratchpad") -> dict:
    """Read one local notebook. The caller persists notebookId for later runs."""
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise CaptureError(f"No reMarkable desktop copy at {source}")
    if notebook_id is not None:
        capture_id(notebook_id)
    if not isinstance(notebook_name, str) or not notebook_name.strip():
        raise CaptureError("A nonempty notebook name is required")
    notebook_id, metadata, newest = capture_index(source, notebook_id, notebook_name)
    content = capture_json(capture_path(source, f"{notebook_id}.content"))
    pages = capture_pages(content)
    decoded = []
    for page in pages:
        page_id = page["id"]
        path = capture_path(source, notebook_id, f"{page_id}.rm")
        text, strokes, data = "", [], b""
        if path.parent.exists() and not path.parent.is_dir():
            raise CaptureError(f"Notebook page directory is not a directory: {path.parent}")
        if not path.exists():
            # The desktop omits untouched pages. Its v2 edit marker (spelled
            # 'modifed' on disk) or sidecars distinguish lost ink from blanks.
            edited = any(capture_milliseconds(page[k]) > 0
                         for k in ("modifed", "modified") if k in page)
            artifacts = list(path.parent.glob(f"{page_id}*"))
            if edited or artifacts:
                raise CaptureError(f"Missing content for edited page {page_id}")
        else:
            try:
                data = path.read_bytes()
                text, strokes = read_page(path, data=data, strict=True)
            except Exception as exc:
                raise CaptureError(f"Cannot decode page {page_id}: {exc}") from exc
        decoded.append((page_id, hashlib.sha256(data).hexdigest(), text, strokes))
    if (all(p[1] == hashlib.sha256(b"").hexdigest() for p in decoded)
            and content.get("sizeInBytes", "0") not in (0, "0")):
        raise CaptureError("Notebook reports content bytes but all page files are missing")

    output = capture_output_dir(source, output_dir)
    manifest_pages = []
    for number, (page_id, fingerprint, text, strokes) in enumerate(decoded, 1):
        page = {"id": page_id, "number": number, "fingerprint": fingerprint, "text": text}
        if strokes:
            page["image"] = capture_image(
                strokes, output, f"{notebook_id}-{page_id}-{fingerprint}.png")
            if text:
                # Ink-only crops cannot locate cross-outs relative to typed text.
                page["reviewOnly"] = True
        manifest_pages.append(page)
    fingerprint = hashlib.sha256(json.dumps(
        [[p["id"], p["fingerprint"]] for p in manifest_pages], separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return {"version": 1, "notebookId": notebook_id, "name": metadata["visibleName"],
            "sourceUpdatedAt": capture_iso(capture_milliseconds(metadata["lastModified"])),
            "newestChangeAt": capture_iso(newest), "fingerprint": fingerprint,
            "pages": manifest_pages}


# --------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", type=Path, default=SOURCE, help="local desktop copy directory")
    ap.add_argument("--notebook-name", help="exact initial notebook name (default: Scratchpad)")
    ap.add_argument("--text", nargs="+", metavar="KEY", help="print these notebooks")
    ap.add_argument("--filed", nargs="+", metavar="KEY=WHERE",
                    help="record where a notebook ended up, so it is not offered again")
    ap.add_argument("--count", action="store_true", help="one line: how many are waiting")
    ap.add_argument("--capture-scratchpad", action="store_true",
                    help="emit a read-only scratchpad JSON manifest, separate from writing")
    ap.add_argument("--output-dir", type=Path, help="private directory for capture PNGs")
    ap.add_argument("--notebook-id", metavar="UUID", help="previously captured stable notebook UUID")
    args = ap.parse_args()
    # rmscene warns about every text formatting code it does not know.
    logging.getLogger("rmscene").setLevel(logging.ERROR)

    if args.capture_scratchpad:
        if not args.output_dir or args.text or args.filed or args.count:
            ap.error("--capture-scratchpad requires --output-dir and cannot use writing flags")
        try:
            manifest = capture_scratchpad(args.source, args.output_dir, args.notebook_id,
                                          args.notebook_name or "Scratchpad")
        except (CaptureError, OSError) as exc:
            ap.exit(2, f"Scratchpad capture failed: {exc}\n")
        print(json.dumps(manifest, ensure_ascii=False))
        return
    if args.output_dir is not None or args.notebook_id is not None or args.notebook_name is not None:
        ap.error("--output-dir, --notebook-id and --notebook-name require --capture-scratchpad")

    docs, newest = load_index(args.source)
    handles = keyed(docs)

    if args.text:
        print_text(args.text, handles)
        return
    if args.filed:
        pairs = {}
        for item in args.filed:
            if "=" not in item:
                raise SystemExit(f"Expected KEY=WHERE, got {item!r}.")
            key, where = item.split("=", 1)
            pairs[key] = where
        for line in record_filed(pairs, handles):
            print(f"filed: {line}")
        return

    todo = waiting(handles, load_ledger())
    if args.count:
        print(f"reMarkable/{FOLDER}: {len(todo)} waiting")
        return
    print(f"desktop copy: newest change {stamp(newest)[:10]}. "
          "Sync the desktop app if you wrote since.")
    print(f"to triage in {FOLDER}: {len(todo)} of {len(docs)}")
    for key, doc, changed in todo:
        extra = " CHANGED since filed" if changed else ""
        print(f"  {key}  {stamp(doc['modified'])[:10]}  {len(doc['pages'])}p{extra}")


if __name__ == "__main__":
    main()
