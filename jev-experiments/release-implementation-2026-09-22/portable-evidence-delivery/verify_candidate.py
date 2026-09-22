#!/usr/bin/env python3
"""Verify an exact Git archive from the canonical app root; retain raw logs privately."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.scratch.exists() or args.output.exists(): parser.error("Use new scratch and report destinations")
    args.scratch.mkdir(mode=0o700)
    archive = args.scratch / "archive"
    archive.mkdir()
    raw = subprocess.check_output(["git", "archive", "--format=tar", args.commit], cwd=args.repository)
    (args.scratch / "source.tar").write_bytes(raw)
    with tarfile.open(fileobj=io.BytesIO(raw)) as source:
        source.extractall(archive, filter="data")
    selection = json.loads(args.selection.read_text())
    selected = {name: row["sha256"] for name, row in selection["selected"].items()}
    def source_matches():
        return all(sha((archive / name).read_bytes()) == h for name, h in selected.items()) and all(not (archive / row["path"]).exists() for row in selection["removals"])
    if not source_matches(): raise ValueError("Archive does not match the selected condition")
    app = "jev-experiments/experience-prototypes"
    bun = Path(shutil.which("bun"))
    records = []
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    def command(name, argv, cwd=".", public_argv=None):
        started = time.monotonic()
        result = subprocess.run(argv, cwd=archive / cwd, env=env, capture_output=True, timeout=300)
        for stream in ("stdout", "stderr"):
            (args.scratch / (name + "." + stream)).write_bytes(getattr(result, stream))
        text = re.sub(r"\x1b\[[0-9;]*m", "", (result.stdout + result.stderr).decode(errors="replace"))
        tests = {}
        for field, pattern in [("passed", r"(\d+) pass\b"), ("failed", r"(\d+) fail\b"), ("assertions", r"(\d+) expect\(\) calls")]:
            found = re.search(pattern, text)
            if found: tests[field] = int(found[1])
        row = {"name": name, "argv": public_argv or argv, "cwd": cwd, "exitCode": result.returncode,
               "elapsedSeconds": round(time.monotonic() - started, 3), "stdoutSha256": sha(result.stdout), "stderrSha256": sha(result.stderr),
               "stdoutBytes": len(result.stdout), "stderrBytes": len(result.stderr)}
        if tests: row["tests"] = tests
        records.append(row)
        return result.returncode == 0
    version = subprocess.check_output([str(bun), "--version"]).decode().strip()
    commands = [
        ("frozen-install", ["bun", "install", "--frozen-lockfile"], app),
        ("canonical-app-build", ["bun", "run", "build"], app),
        ("portable-tests", ["bun", "test", "jev-experiments/roadmap/integration/portable-records.test.ts",
                            "jev-experiments/roadmap/integration/portable-clients.test.ts", "jev-experiments/roadmap/integration/portable-publication.test.ts",
                            "jev-experiments/capability-atlas-2026-09-22/publication-projection.test.ts"], "."),
        ("archive-index", ["python3", "jev-experiments/roadmap/integration/evidence_index.py"], "."),
        ("public-integrity", ["bun", "run", "jev-experiments/roadmap/verification/publication.ts"], "."),
    ]
    completed = True
    for name, argv, cwd in commands:
        if not command(name, argv, cwd):
            completed = False
            break
    graph = None
    if completed:
        entry = "jev-experiments/capability-atlas-2026-09-22/publication-projection.ts"
        bundle, metadata = args.scratch / "projection.js", args.scratch / "projection.meta.json"
        argv = ["bun", "build", entry, "--target=bun", "--outfile=" + str(bundle), "--metafile=" + str(metadata)]
        completed = command("projection-import-closure", argv, public_argv=["bun", "build", entry, "--target=bun", "--outfile=<private-bundle>", "--metafile=<private-metadata>"])
        if completed:
            data = json.loads(metadata.read_text())
            inputs, external = {}, set()
            for name, item in data["inputs"].items():
                path = Path(name)
                path = path if path.is_absolute() else archive / path
                relative = path.resolve().relative_to(archive.resolve()).as_posix()
                actual = path.read_bytes()
                committed = subprocess.check_output(["git", "show", args.commit + ":" + relative], cwd=args.repository)
                if actual != committed: raise ValueError("Uncommitted projection import")
                inputs[relative] = {"sha256": sha(actual), "bytes": len(actual)}
                external.update(i["path"] for i in item.get("imports", []) if i.get("external"))
            graph = {"inputs": inputs, "externalImports": sorted(external), "bundleSha256": sha(bundle.read_bytes()),
                     "allInputsMatchCommittedSource": True, "metadataSha256": sha(metadata.read_bytes())}
    downloads = None
    index = archive / app / "public/routing-evidence/index.json"
    if index.exists():
        value = json.loads(index.read_text())
        rows = value["publication_projection"]["files"]
        source_root = archive / "jev-experiments/roadmap/integration/evidence"
        all_bound = all(sha((source_root / row["sourcePath"]).read_bytes()) == row["sourceSha256"] and sha((index.parent / row["path"]).read_bytes()) == row["publishedSha256"] for row in rows)
        committed_inputs = all(subprocess.run(["git", "cat-file", "-e", args.commit + ":jev-experiments/roadmap/integration/evidence/" + row["sourcePath"]], cwd=args.repository, capture_output=True).returncode == 0 for row in rows)
        downloads = {"runs": len(value["runs"]), "filesIncludingIndex": len(rows) + 1, "indexSha256": sha(index.read_bytes()),
                     "everyDownloadMatchesSourceAndPublishedHashes": all_bound, "everyPublicationInputCommitted": committed_inputs,
                     "files": {row["path"]: {"sourcePath": row["sourcePath"], "sourceSha256": row["sourceSha256"], "publishedSha256": row["publishedSha256"]} for row in rows}}
    after = source_matches()
    all_passed = bool(completed and after and graph and downloads and downloads["everyDownloadMatchesSourceAndPublishedHashes"] and downloads["everyPublicationInputCommitted"])
    report = {"condition": "Fresh exact Git archive; canonical app-root frozen install/build before any sibling install", "commit": args.commit,
              "archiveSha256": sha(raw), "bunVersion": version, "bunExecutableSha256": sha(bun.read_bytes()),
              "checks": records, "sourceConditionPreserved": after, "projectionImportClosure": graph, "downloads": downloads,
              "allPassed": all_passed, "providerCallsRequested": False, "remoteCiExecuted": False,
              "limits": ["Package installation may access registries; no OS network isolation was used.", "This is local execution of the focused CI commands, not a remote CI result or deployment.", "Historical client outcomes are retained, not rerun or regraded."]}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"allPassed": all_passed, "commands": len(records), "commit": args.commit,
                      "tests": next((r.get("tests") for r in records if r["name"] == "portable-tests"), None)}))
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
