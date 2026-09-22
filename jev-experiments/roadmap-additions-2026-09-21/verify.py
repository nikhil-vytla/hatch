"""Check this research bundle's links, captures and incremental roadmap patch."""

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Update verification.json")
    args = parser.parse_args()
    folder = Path(__file__).resolve().parent
    root = folder.parent.parent
    patch = folder / "roadmap-update.patch"
    manifest = json.loads((folder / "patch-manifest.json").read_text())
    prerequisite = folder / manifest["prerequisitePatch"]
    assert digest(patch.read_bytes()) == manifest["patchSha256"]
    assert digest(prerequisite.read_bytes()) == manifest["prerequisiteSha256"]

    with tempfile.TemporaryDirectory(prefix="jev-roadmap-check-") as temp:
        checkout = Path(temp)
        for item in manifest["files"]:
            destination = checkout / item["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(
                subprocess.check_output(
                    ["git", "show", f"{manifest['baseCommit']}:{item['path']}"], cwd=root
                )
            )
        for current in (prerequisite, patch):
            subprocess.run(["git", "apply", "--check", str(current)], cwd=checkout, check=True)
            subprocess.run(["git", "apply", str(current)], cwd=checkout, check=True)
            expected = "beforeSha256" if current == prerequisite else "afterSha256"
            for item in manifest["files"]:
                assert digest((checkout / item["path"]).read_bytes()) == item[expected]

    link_count = 0
    for document in folder.rglob("*.md"):
        for link in re.findall(r"\[[^\]]*\]\(([^)]+)\)", document.read_text()):
            if link.startswith(("https:", "http:", "mailto:")):
                continue
            path, _, anchor = link.partition("#")
            destination = (document.parent / path).resolve() if path else document
            assert destination.exists(), f"{document.name}: missing {link}"
            if anchor and destination.suffix == ".md":
                headings = re.findall(r"^#{1,6}\s+(.*)$", destination.read_text(), re.M)
                anchors = {
                    re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
                    for heading in headings
                }
                assert anchor in anchors, f"{document.name}: missing anchor {link}"
            link_count += 1

    captures = json.loads((folder / "capture-manifest.json").read_text())["captures"]
    for item in captures:
        data = (folder / item["path"]).read_bytes()
        assert digest(data) == item["sha256"]
        assert len(data) == item["bytes"] < 2_000_000

    report = {
        "kind": "research-artifact-verification",
        "relativeLinksAndAnchors": {"status": "passed", "count": link_count},
        "cleanBasePatchSequence": {"status": "passed", "files": len(manifest["files"])},
        "captures": {"status": "passed", "count": len(captures), "limitBytesEach": 2_000_000},
        "scope": "Links, hashes, file sizes and patch application only; no model or app evaluation",
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.write:
        (folder / "verification.json").write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
