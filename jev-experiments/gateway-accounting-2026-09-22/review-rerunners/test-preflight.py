#!/usr/bin/env python3
"""Check the published rerunners without executing Bun or changing recorded results."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v2-archive", required=True, type=Path)
    parser.add_argument("--v3-archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if os.path.lexists(args.output):
        parser.error("The verification output must be new.")
    root = Path(__file__).resolve().parent.parent
    rows = []
    with tempfile.TemporaryDirectory(prefix="gateway-rerunner-preflight-") as temporary:
        scratch = Path(temporary)
        for version in ["v2", "v3"]:
            driver = root / ("independent-review-" + version) / "run-review.py"
            archive = getattr(args, version + "_archive").resolve()
            case_root = scratch / version
            case_root.mkdir()
            def check(name, arguments, expected, output=None, sentinel=None):
                result = subprocess.run([sys.executable, str(driver), *map(str, arguments)], capture_output=True, text=True)
                valid = result.returncode == expected
                if output is not None:
                    valid = valid and not os.path.lexists(output)
                if sentinel is not None:
                    valid = valid and sentinel.read_bytes() == b"immutable"
                rows.append({"version": version, "case": name, "expectedExitCode": expected,
                             "actualExitCode": result.returncode, "passed": valid})
            check("help", ["--help"], 0)
            check("required arguments", [], 2)
            existing = case_root / "existing"
            existing.mkdir()
            sentinel = existing / "sentinel"
            sentinel.write_bytes(b"immutable")
            check("existing directory refused", ["--archive", archive, "--output", existing], 2, sentinel=sentinel)
            check("existing file refused", ["--archive", archive, "--output", sentinel], 2, sentinel=sentinel)
            link = case_root / "dangling"
            link.symlink_to(case_root / "absent")
            check("dangling output symlink refused", ["--archive", archive, "--output", link], 2)
            out = case_root / "missing-source-output"
            check("missing archive refused before output", ["--archive", case_root / "missing", "--output", out, "--preflight-only"], 2, output=out)
            out = case_root / "wrong-condition-output"
            other = args.v3_archive if version == "v2" else args.v2_archive
            check("wrong archive identity refused", ["--archive", other, "--output", out, "--preflight-only"], 2, output=out)
            out = archive / "review-output-must-not-exist"
            check("archive output refused", ["--archive", archive, "--output", out, "--preflight-only"], 2, output=out)
            mirror = case_root / "changed-selected-source"
            (mirror / "source").mkdir(parents=True)
            (mirror / "source.tar").symlink_to(archive / "source.tar")
            manifest = json.loads((root / ("source-" + version + ".json")).read_text())
            for entry in manifest["files"]:
                target = mirror / "source" / entry["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((archive / "source" / entry["path"]).read_bytes())
            first = mirror / "source" / manifest["files"][0]["path"]
            first.write_bytes(first.read_bytes() + b"\n// authored preflight mismatch\n")
            out = case_root / "changed-source-output"
            check("changed selected source refused", ["--archive", mirror, "--output", out, "--preflight-only"], 2, output=out)
            out = case_root / "valid-output"
            check("valid preflight creates no output", ["--archive", archive, "--output", out, "--preflight-only"], 0, output=out)
    result = {"suitesExecuted": False, "checks": rows, "passed": all(row["passed"] for row in rows)}
    with args.output.open("x") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"checks": len(rows), "passed": result["passed"], "suitesExecuted": False}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
