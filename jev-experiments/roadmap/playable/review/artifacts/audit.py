#!/usr/bin/env python3
"""Offline, scoped artifact inventory. Never prints matched private values."""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
ROADMAP = REPO / "jev-experiments/roadmap"
SCOPES = [ROADMAP / name for name in ("design-research", "materials", "playable", "tetris")]
LIMIT = 2_000_000
PATTERNS = {
    "private_key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "aws_access_key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "provider_key": r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b",
    "literal_bearer": r"\bBearer\s+[A-Za-z0-9_./+=-]{20,}",
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    "user_home": r"/(?:Users|home)/[^/\s\"']+",
    "signed_url": r"(?:X-Amz-Signature|X-Goog-Signature|[?&](?:access_token|api_key|token)=)[A-Za-z0-9%_-]{12,}",
}


def relative(path: Path) -> str:
    return str(path.relative_to(REPO))


def ignored(path: Path) -> bool:
    result = subprocess.run(["git", "check-ignore", "--", relative(path)], cwd=REPO,
                            capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError("git check-ignore failed")
    return result.returncode == 0


def webp_chunks(data: bytes) -> list[str]:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("Unexpected WebP header")
    chunks, offset = [], 12
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        chunks.append(data[offset:offset + 4].decode("ascii"))
        offset += 8 + size + size % 2
    if offset != len(data):
        raise ValueError("Unexpected WebP chunk boundary")
    return chunks


class BoardParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.figures, self.active = [], None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "figure":
            self.active = {"images": [], "sourceUrls": [], "caption": ""}
        if self.active is None:
            return
        if tag == "img":
            self.active["images"].append({"src": attrs.get("src"), "alt": attrs.get("alt", "")})
        if tag == "a" and attrs.get("href", "").startswith("https://"):
            self.active["sourceUrls"].append(attrs["href"])

    def handle_data(self, data):
        if self.active is not None:
            self.active["caption"] += data

    def handle_endtag(self, tag):
        if tag == "figure" and self.active is not None:
            self.figures.append(self.active)
            self.active = None


def main():
    files, directories, symlinks, privacy_flags = [], [], [], []
    for scope in SCOPES:
        for path in sorted(scope.rglob("*")):
            if path == HERE or HERE in path.parents:
                continue  # Avoid recursive output and pattern-source false positives.
            if path.is_symlink():
                symlinks.append(relative(path))
                continue
            if path.is_dir():
                if path.name in {".git", "node_modules", ".venv", "venv", "target", "__pycache__"}:
                    directories.append(relative(path))
                continue
            if not path.is_file():
                continue
            data = path.read_bytes()
            record = {"path": relative(path), "bytes": len(data),
                      "sha256": hashlib.sha256(data).hexdigest(), "ignored": ignored(path)}
            try:
                content = data.decode("utf-8")
                record["kind"] = "text"
                for kind, pattern in PATTERNS.items():
                    for match in re.finditer(pattern, content):
                        privacy_flags.append({"path": relative(path), "line": content[:match.start()].count("\n") + 1,
                                              "kind": kind})
            except UnicodeDecodeError:
                record["kind"] = "binary"
                if path.suffix == ".webp":
                    record["webpChunks"] = webp_chunks(data)
                    record["hasExifOrXmp"] = any(chunk in {"EXIF", "XMP "} for chunk in record["webpChunks"])
            files.append(record)

    parser = BoardParser()
    board = ROADMAP / "design-research/reference-board.html"
    parser.feed(board.read_text())
    for figure in parser.figures:
        figure["sourceUrls"] = sorted(set(figure["sourceUrls"]))
        figure["allImagesExist"] = all((board.parent / item["src"]).is_file() for item in figure["images"])
        figure["hasSourceAndDescription"] = bool(figure["sourceUrls"] and figure["caption"].strip()
                                                and all(item["alt"] for item in figure["images"]))
    binaries = [record for record in files if record["kind"] == "binary"]
    archives = [record["path"] for record in files if record["path"].endswith(
        (".zip", ".tar", ".tar.gz", ".tgz", ".whl", ".dmg", ".pkg", ".onnx", ".safetensors"))]
    result = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "scope": [relative(path) for path in SCOPES],
        "excluded": [relative(HERE)],
        "byteLimit": LIMIT,
        "fileCount": len(files),
        "binaryCount": len(binaries),
        "totalBinaryBytes": sum(record["bytes"] for record in binaries),
        "filesAtOrOverLimit": [record["path"] for record in files if record["bytes"] >= LIMIT],
        "dependencyOrRepositoryTrees": directories,
        "archiveOrModelCandidates": archives,
        "symlinks": symlinks,
        "privacyPatternFlags": privacy_flags,
        "referenceFigures": parser.figures,
        "files": files,
        "limits": "Inventory and pattern matches are not a forensic privacy or source-origin proof. Manual screenshot and prose review is recorded in README.md. No network, model, browser or performance work was run.",
    }
    (HERE / "artifact-inventory.json").write_text(json.dumps(result, indent=2) + "\n")
    selected = [record["path"] for record in binaries if record["path"].endswith(".webp") and record["bytes"] < LIMIT]
    (HERE / "selected-binaries.txt").write_text("\n".join(selected) + "\n")
    print(json.dumps({key: result[key] for key in ("fileCount", "binaryCount", "totalBinaryBytes",
                     "filesAtOrOverLimit", "dependencyOrRepositoryTrees", "archiveOrModelCandidates", "privacyPatternFlags")}, indent=2))


if __name__ == "__main__":
    main()
