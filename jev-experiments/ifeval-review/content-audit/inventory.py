#!/usr/bin/env python3
"""Decode published Jev records and emit a review inventory or candidate list."""

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "experience-prototypes"
sys.path.insert(0, str(ROOT / "src"))

from jev_lab.records import read_record  # noqa: E402


TERMS = re.compile(
    r"\b(?:fuck\w*|shit\w*|bitch\w*|cunt\w*|nigg\w*|fagg\w*|retard\w*|"
    r"whore\w*|slut\w*|rape\w*|rapist\w*|porn\w*|sex(?:ual(?:ly)?)?|nude|"
    r"naked|kill\w*|murder\w*|suicid\w*|bomb\w*|weapon\w*|poison\w*|"
    r"terroris\w*|genocide\w*|tortur\w*|abuse\w*|racis\w*|sexist\w*|"
    r"homophob\w*|hate\w*|inferior|supremac\w*|slave\w*|holocaust|nazi\w*)\b",
    re.IGNORECASE,
)


def strings(value, path=()):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from strings(item, (*path, index))
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings(item, (*path, key))


def path_text(path):
    return "/".join(map(str, path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("summary", "candidates", "all"), default="summary")
    args = parser.parse_args()
    publication = json.loads((APP / "publication.json").read_text())
    for name, relative in publication.items():
        document = read_record((APP / relative).resolve())
        items = list(strings(document))
        candidates = [(path, text) for path, text in items if TERMS.search(text)]
        if args.mode == "summary":
            rows = document.get("result", {}).get("rows") if isinstance(document, dict) else None
            print(json.dumps({
                "dataset": name,
                "strings": len(items),
                "characters": sum(len(text) for _, text in items),
                "rows": len(rows) if isinstance(rows, list) else None,
                "candidate_strings": len(candidates),
            }))
            continue
        selected = items if args.mode == "all" else candidates
        for path, value in selected:
            print(json.dumps({"dataset": name, "path": path_text(path), "text": value}, ensure_ascii=False))


if __name__ == "__main__":
    main()
