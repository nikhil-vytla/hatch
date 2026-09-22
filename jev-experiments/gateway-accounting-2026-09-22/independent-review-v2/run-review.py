#!/usr/bin/env python3
"""Rerun one pinned review into a new destination; never update historical results."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

VERSION = "v2"
SOURCE_COMMIT = "8743d7282176e2bdbcff68ddc497c8803b55b6c0"
ARCHIVE_SHA256 = "5885028b448cc7c7d2a21df0561d60f60e1ca051479cbf4be8fe3f21b7f27423"
MAINTAINED_TARGETS = ['gateway-accounting-2026-09-22', 'experience-prototypes/server/byok.test.ts', 'experience-prototypes/server/gateway.test.ts', 'roadmap/runtime/existing-contract.test.ts']
REVIEW_TARGET = "missed-cases.test.ts"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path,
                        help="Verified archive directory containing source.tar and dependency-prepared source/.")
    parser.add_argument("--output", required=True, type=Path,
                        help="New results directory; an existing destination is refused.")
    parser.add_argument("--preflight-only", action="store_true",
                        help="Check arguments, archive and selected source identities without running suites or creating output.")
    args = parser.parse_args()
    if os.path.lexists(args.output):
        parser.error("Output destination already exists; historical results must remain immutable.")
    archive, output = args.archive.resolve(), args.output.resolve()
    if output == archive or archive in output.parents:
        parser.error("Output must be outside the archive directory.")
    review = Path(__file__).resolve().parent
    source = archive / "source"
    try:
        if not source.is_dir() or not (archive / "source.tar").is_file():
            parser.error("Archive requires source.tar and an extracted source directory.")
        if digest(archive / "source.tar") != ARCHIVE_SHA256:
            parser.error("Archive digest does not match this review condition.")
        manifest = json.loads((review.parent / f"source-{VERSION}.json").read_text())
        if manifest["sourceCommit"] != SOURCE_COMMIT or manifest["archiveSha256"] != ARCHIVE_SHA256:
            parser.error("Source manifest does not match this review condition.")
        for entry in manifest["files"]:
            relative = Path(entry["path"])
            if relative.is_absolute() or ".." in relative.parts or digest(source / relative) != entry["sha256"]:
                parser.error("An extracted selected source file differs from the pinned manifest.")
        if not (review / REVIEW_TARGET).is_file() or (VERSION == "v2" and not (review / "observations.ts").is_file()):
            parser.error("A review fixture is missing.")
    except (OSError, ValueError, KeyError, TypeError):
        parser.error("Cannot validate the archive and selected source inputs.")
    if shutil.which("bun") is None:
        parser.error("Bun must be available on PATH.")
    if args.preflight_only:
        print(json.dumps({"preflight": "passed", "sourceCommit": SOURCE_COMMIT,
                          "selectedFiles": len(manifest["files"]), "suitesExecuted": False,
                          "outputCreated": False}))
        return 0
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        parser.error("Output destination appeared during preflight; refusing to overwrite it.")
    env = {"PATH": os.environ.get("PATH", os.defpath), "CI": "1", "NO_COLOR": "1",
           "JEV_GATEWAY_REVIEW_SOURCE": str(source)}
    commands = [("existing", ["bun", "test", *MAINTAINED_TARGETS]),
                ("regressions", ["bun", "test", str(review / REVIEW_TARGET)])]
    if VERSION == "v2":
        # Its import.meta.dir output is redirected by running an identical copy.
        shutil.copyfile(review / "observations.ts", output / "observations.ts")
        commands.append(("observations", ["bun", str(output / "observations.ts")]))
    results = []
    for name, command in commands:
        timed_out = False
        try:
            result = subprocess.run(command, cwd=source / "jev-experiments", env=env,
                                    capture_output=True, text=True, timeout=60)
            code, text = result.returncode, result.stdout + result.stderr
        except subprocess.TimeoutExpired as error:
            timed_out = True
            code = None
            chunks = [error.stdout or b"", error.stderr or b""]
            text = "".join(chunk.decode(errors="replace") if isinstance(chunk, bytes) else chunk for chunk in chunks)
        for actual, label in [(str(archive), "<archive>"), (str(review), "<review>"), (str(output), "<output>")]:
            text = text.replace(actual, label)
        (output / f"{name}.log").write_text(text)
        results.append({"name": name, "exitCode": code, "timedOut": timed_out,
                        "summaries": [line.strip() for line in text.splitlines()
                                      if re.match(r"\s*\d+ (pass|fail|expect\(\) calls)", line)],
                        "logSha256": hashlib.sha256(text.encode()).hexdigest()})
    (output / "review-checks.json").write_text(json.dumps(results, indent=2) + "\n")
    (output / "rerun-provenance.json").write_text(json.dumps({
        "recordedAt": datetime.now(timezone.utc).isoformat(), "sourceCommit": SOURCE_COMMIT,
        "archiveSha256": ARCHIVE_SHA256, "executedDriverSha256": digest(Path(__file__)),
        "reviewFixtureSha256": digest(review / REVIEW_TARGET),
        "observationsFixtureSha256": digest(review / "observations.ts") if VERSION == "v2" else None,
        "condition": "New rerun; archive digest and selected extracted-source identities verified; dependencies already prepared by the caller.",
        "historicalResultsModified": False,
    }, indent=2) + "\n")
    print(json.dumps(results))
    return 0 if all(row["exitCode"] == 0 and not row["timedOut"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
