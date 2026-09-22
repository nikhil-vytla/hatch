"""Check the authored delivery without installing dependencies or calling a provider."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest = json.loads((HERE / "patch-manifest.json").read_text())
assert sha((HERE / "application.patch").read_bytes()) == manifest["applicationPatchSha256"]
assert sha((HERE / "roadmap-update.patch").read_bytes()) == manifest["roadmapPatchSha256"]
with tempfile.TemporaryDirectory(prefix="jev-artwork-check-") as directory:
    snapshot = Path(directory)
    for entry in manifest["applicationFiles"]:
        data = subprocess.check_output(["git", "show", f'{manifest["baseCommit"]}:{entry["path"]}'], cwd=ROOT)
        assert sha(data) == entry["beforeSha256"]
        target = snapshot / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    subprocess.run(["git", "apply", "--check", str(HERE / "application.patch")], cwd=snapshot, check=True)
    subprocess.run(["git", "apply", str(HERE / "application.patch")], cwd=snapshot, check=True)
    for entry in manifest["applicationFiles"]:
        assert sha((snapshot / entry["path"]).read_bytes()) == entry["afterSha256"]
    map_path = "jev-experiments/roadmap/MAP.md"
    target = snapshot / map_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(["git", "show", f'{manifest["baseCommit"]}:{map_path}'], cwd=ROOT))
    for patch in [HERE.parent / "design-revamp-2026-09-21/roadmap-update.patch", HERE.parent / "roadmap-additions-2026-09-21/roadmap-update.patch"]:
        subprocess.run(["git", "apply", "--include=" + map_path, str(patch)], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["roadmapBeforeSha256"]
    subprocess.run(["git", "apply", str(HERE / "roadmap-update.patch")], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["roadmapAfterSha256"]
links = 0
for document in HERE.glob("*.md"):
    for target in re.findall(r"\]\(([^)]+)\)", document.read_text()):
        if "://" in target or target.startswith("#"):
            continue
        path = target.split("#")[0]
        assert (document.parent / path).exists(), f"Broken link in {document.name}: {target}"
        links += 1
captures = json.loads((HERE / "captures.json").read_text())["captures"]
for capture in captures:
    data = (HERE / capture["path"]).read_bytes()
    assert len(data) == capture["bytes"] and len(data) < 2_000_000
    assert sha(data) == capture["sha256"]
print(json.dumps({"application_patch": "passed", "roadmap_patch_chain": "passed", "local_links": links, "captures": len(captures)}))
