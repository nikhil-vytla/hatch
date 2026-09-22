"""Verify the authored atlas, evidence references and ordered integration patches."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def original(path, revision):
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=ROOT)


manifest = json.loads((HERE / "patch-manifest.json").read_text())
assert sha((HERE / "roadmap-update.patch").read_bytes()) == manifest["patchSha256"]
with tempfile.TemporaryDirectory(prefix="jev-atlas-map-") as directory:
    snapshot = Path(directory)
    target = snapshot / manifest["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(original(manifest["path"], manifest["baseCommit"]))
    for prerequisite in manifest["prerequisites"]:
        patch = HERE / prerequisite["path"]
        assert sha(patch.read_bytes()) == prerequisite["sha256"]
        subprocess.run(["git", "apply", "--include=" + manifest["path"], str(patch)], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["beforeSha256"]
    subprocess.run(["git", "apply", str(HERE / "roadmap-update.patch")], cwd=snapshot, check=True)
    assert sha(target.read_bytes()) == manifest["afterSha256"]

application = manifest["application"]
assert sha((HERE / application["patch"]).read_bytes()) == application["sha256"]
assert sha((HERE / application["prerequisite"]).read_bytes()) == application["prerequisiteSha256"]
with tempfile.TemporaryDirectory(prefix="jev-atlas-app-") as directory:
    snapshot = Path(directory)
    patches = [HERE / application["prerequisite"], HERE / application["patch"]]
    paths = set()
    for patch in patches:
        paths.update(re.findall(r"^--- a/(.+)$", patch.read_text(), re.M))
    for path in paths:
        target = snapshot / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original(path, manifest["baseCommit"]))
    for patch in patches:
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=snapshot, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=snapshot, check=True)

catalog = json.loads((HERE / "catalog-snapshot.json").read_text())
atlas = json.loads((HERE / "atlas.json").read_text())
records = atlas["records"]
assert len(records) == len({record["id"] for record in records}) == 41
assert [record["id"] for record in records] == [entry["id"] for entry in catalog]
references = 0
for record in records:
    for field in ("input", "questions", "distribution_use", "output_effect", "execution_modes", "recorded_evidence", "depth_opportunity"):
        assert record[field], (record["id"], field)
    assert record["native_structure_status"] in (False, "not-applicable")
    for evidence in record["evidence"]:
        assert (ROOT / evidence["path"]).is_file(), evidence["path"]
        assert re.fullmatch(r"[0-9a-f]{64}", evidence["sha256"])
        assert evidence["symbol"]
        references += 1
html = (HERE / "show-me-jev-capabilities.html").read_text()
embedded = re.search(r'<script type="application/json" id="atlas-data">(.*?)</script>', html, re.S)
assert json.loads(embedded.group(1)) == atlas
assert (HERE / "atlas.css").read_text() in html
assert (HERE / "atlas.js").read_text() in html
assert "Not affiliated with or endorsed by TypeSafe AI" in html
assert 'src="http' not in html

links = 0
for document in HERE.rglob("*.md"):
    targets = re.findall(r"\]\(([^)]+)\)", document.read_text())
    for target in targets:
        if "://" in target or target.startswith("#"):
            continue
        assert (document.parent / target.split("#")[0]).exists(), (document.name, target)
        links += 1
checks = json.loads((HERE / "browser-checks.json").read_text())
assert all(checks["standalone"].values()) and all(checks["inspector"].values())
for image in (HERE / "screenshots").glob("*"):
    assert image.stat().st_size < 2_000_000
result = {
    "checked_on": "2026-09-22", "catalog_entries": len(records),
    "evidence_references": references, "local_links": links,
    "embedded_atlas": "matches", "roadmap_patch_chain": "passed",
    "application_patch_chain": "passed",
    "browser_assertions": len(checks["standalone"]) + len(checks["inspector"]),
    "scope": "Artifact integrity and recorded local browser checks. Source hashes identify the audited snapshot; a build guard checks current source separately. No new model evaluations.",
}
(HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
