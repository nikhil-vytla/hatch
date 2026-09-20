"""Lossless JSONL evidence storage; the web build reconstructs ordinary JSON."""
import json
from pathlib import Path
from uuid import uuid4

FORMAT = "jev-records-v1"


def encode_record(document):
    entries = []

    def visit(value, path):
        if isinstance(value, list):
            entries.extend({"path": path, "index": i, "value": item} for i, item in enumerate(value))
            return []
        if isinstance(value, dict):
            return {key: visit(item, [*path, key]) for key, item in value.items()}
        return value

    skeleton = visit(document, [])
    return "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n" for record in [{"format": FORMAT, "document": skeleton}, *entries])


def decode_record(text):
    lines = text.rstrip("\r\n").split("\n")
    header = json.loads(lines[0])
    if header.get("format") != FORMAT or "document" not in header:
        raise ValueError("Unknown result format")
    for line in lines[1:]:
        entry = json.loads(line)
        path, index = entry.get("path"), entry.get("index")
        if not isinstance(path, list) or not all(isinstance(key, str) for key in path) or type(index) is not int or "value" not in entry:
            raise ValueError("Invalid result entry")
        target = header["document"]
        for key in path:
            if not isinstance(target, dict) or key not in target:
                raise ValueError("Invalid result path")
            target = target[key]
        if not isinstance(target, list) or index != len(target):
            raise ValueError("Result entries must be ordered and contiguous")
        target.append(entry["value"])
    return header["document"]


def read_record(path):
    return decode_record(Path(path).read_text())


def write_record(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{uuid4().hex}.tmp")
    temporary.write_text(encode_record(document))
    temporary.replace(path)
