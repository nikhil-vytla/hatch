"""Check authored links, source metadata and the incremental roadmap patch."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


manifest = json.loads((HERE / "patch-manifest.json").read_text())
patch_path = HERE / "roadmap-update.patch"
assert manifest["path"] == "jev-experiments/roadmap/MAP.md"
assert sha(patch_path.read_bytes()) == manifest["patchSha256"]
patch_headers = re.findall(r"^(?:---|\+\+\+) [ab]/(.+)$", patch_path.read_text(), re.M)
assert patch_headers == [manifest["path"], manifest["path"]]

with tempfile.TemporaryDirectory(prefix="jev-browser-map-check-") as directory:
    snapshot = Path(directory)
    target = snapshot / manifest["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(
        ["git", "show", f'{manifest["baseCommit"]}:{manifest["path"]}'], cwd=ROOT
    ))
    for prerequisite in manifest["prerequisites"]:
        patch = HERE / prerequisite["path"]
        assert sha(patch.read_bytes()) == prerequisite["sha256"]
        subprocess.run(
            ["git", "apply", "--include=" + manifest["path"], str(patch)],
            cwd=snapshot, check=True,
        )
    assert sha(target.read_bytes()) == manifest["beforeSha256"]
    subprocess.run(["git", "apply", "--check", str(patch_path)], cwd=snapshot, check=True)
    subprocess.run(["git", "apply", str(patch_path)], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["afterSha256"]

links = 0
for document in HERE.rglob("*.md"):
    text = document.read_text()
    targets = re.findall(r"\]\(([^)]+)\)", text)
    targets += re.findall(r"^\[[^\]]+\]:\s+(\S+)", text, re.M)
    for target in targets:
        if "://" in target or target.startswith("#"):
            continue
        assert (document.parent / target.split("#")[0]).exists(), (
            f"Broken link in {document.name}: {target}"
        )
        links += 1

sources = json.loads((HERE / "source-index.json").read_text())["sources"]
assert len({source["id"] for source in sources}) == len(sources) == 3
for source in sources:
    assert source["url"].startswith("https://")
    assert re.fullmatch(r"[0-9a-f]{64}", source["sha256"])
    assert source["bytes"] > 0 and source["credit"] and source["reuse"]
    if "revision" in source:
        assert re.fullmatch(r"[0-9a-f]{40}", source["revision"])
        assert source["revision"] in source["inspected_url"]
        assert source["license_observation"]
    if "analysis" in source:
        analysis = (HERE / source["analysis"]).read_text()
        assert source["sha256"] in analysis

result = {
    "checked_on": "2026-09-22",
    "local_links": links,
    "source_records": len(sources),
    "prerequisite_map_patches": len(manifest["prerequisites"]),
    "map_patch_chain": "passed",
    "result_hash": manifest["afterSha256"],
    "scope": "Documentation and patch integrity only. Browser implementation, model training and proposed evaluations have not run.",
}
(HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
