# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Review or add actions in an explicitly selected Apple Reminders list.

No titles: list open reminders. Titles: preview additions without writing.
Only --apply creates reminders. Existing open titles are deduplicated.

Usage:
    uv run helpers/to_next.py --list Next
    uv run helpers/to_next.py --list Next "Review synthetic project estimate"
    uv run helpers/to_next.py --list Next --apply -- "Review synthetic project estimate"
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reminders import build_backend  # noqa: E402

DEFAULT_LIST = "Next"


def to_next(backend, list_name: str, titles: list[str], apply: bool) -> dict:
    result = {"list": list_name, "added": [], "skipped": []}
    open_titles = {t["title"].strip().casefold() for t in backend.open_tasks(list_name)}

    for raw in titles:
        title = " ".join(raw.split())
        key = title.casefold()
        if not title or key in open_titles:
            result["skipped"].append(title)
            continue
        if apply:
            backend.add(list_name, title)
        open_titles.add(key)
        result["added"].append(title)

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Add actions to a Reminders list.")
    parser.add_argument("titles", nargs="*", help="One action per argument. None: list what is open")
    parser.add_argument("--list", default=DEFAULT_LIST, help=f"Reminders list (default: {DEFAULT_LIST})")
    parser.add_argument("--apply", action="store_true", help="Actually create the reminders (default: dry run)")
    args = parser.parse_args()

    if not args.titles:
        tasks = build_backend().open_tasks(args.list)
        print(json.dumps([{"title": t["title"], "due": t["due"]} for t in tasks], indent=2, ensure_ascii=False))
        return

    result = to_next(build_backend(), args.list, args.titles, args.apply)
    result["mode"] = "apply" if args.apply else "dry-run"
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
