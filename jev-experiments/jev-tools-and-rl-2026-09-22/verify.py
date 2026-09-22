"""Validate source metadata, authored links and the incremental roadmap patch."""
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
assert sha((HERE / "roadmap-update.patch").read_bytes()) == manifest["patchSha256"]
with tempfile.TemporaryDirectory(prefix="jev-roadmap-check-") as directory:
    snapshot = Path(directory)
    target = snapshot / manifest["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(["git", "show", f'{manifest["baseCommit"]}:{manifest["path"]}'], cwd=ROOT))
    for prerequisite in manifest["prerequisites"]:
        patch = HERE / prerequisite["path"]
        assert sha(patch.read_bytes()) == prerequisite["sha256"]
        subprocess.run(["git", "apply", "--include=" + manifest["path"], str(patch)], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["beforeSha256"]
    subprocess.run(["git", "apply", "--check", str(HERE / "roadmap-update.patch")], cwd=snapshot, check=True)
    subprocess.run(["git", "apply", str(HERE / "roadmap-update.patch")], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["afterSha256"]
links = 0
for document in HERE.rglob("*.md"):
    text = document.read_text()
    targets = re.findall(r"\]\(([^)]+)\)", text) + re.findall(r"^\[[^\]]+\]:\s+(\S+)", text, re.M)
    for target in targets:
        if "://" in target or target.startswith("#"):
            continue
        path = target.split("#")[0]
        assert (document.parent / path).exists(), f"Broken link in {document.name}: {target}"
        links += 1
index = json.loads((HERE / "source-index.json").read_text())
for project in index["projects"]:
    assert re.fullmatch(r"[0-9a-f]{40}", project["revision"])
    assert project["revision"] in (HERE / project["analysis"]).read_text()
    assert project["credit"] and project["license_observation"]
result = {"checked_on": "2026-09-22", "local_links": links, "pinned_project_studies": len(index["projects"]), "decision_tickets": len(list((HERE / "decisions").glob("*.md"))), "map_patch_chain": "passed", "result_hash": manifest["afterSha256"], "scope": "Documentation and patch integrity only; proposed evaluations and training have not run."}
(HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
