#!/usr/bin/env python3
"""Check the native gateway slice from one Git archive without local overlays."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tarfile
import tempfile
import time


CHECKS = [
    ("app frozen install", "experience-prototypes", ["bun", "install", "--frozen-lockfile"]),
    ("app production build", "experience-prototypes", ["bun", "run", "build"]),
    ("gateway, score, accounting and existing transport contracts", ".", ["bun", "test", "gateway-accounting-2026-09-22", "experience-prototypes/server/byok.test.ts", "experience-prototypes/server/gateway.test.ts", "roadmap/runtime/existing-contract.test.ts"]),
    ("publication integrity", "roadmap", ["bun", "verification/publication.ts"]),
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ref")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    args = parser.parse_args()
    if args.report.exists() or args.scratch.exists():
        parser.error("Preserve earlier conditions; use new report and scratch paths.")
    repo = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    commit = subprocess.check_output(["git", "rev-parse", "--verify", f"{args.ref}^{{commit}}"], text=True).strip()
    scratch = args.scratch.resolve()
    scratch.mkdir(mode=0o700, parents=True)
    archive = subprocess.check_output(["git", "archive", "--format=tar", commit])
    (scratch / "source.tar").write_bytes(archive)
    source = scratch / "source"
    source.mkdir()
    with tarfile.open(scratch / "source.tar") as stream:
        for member in stream.getmembers():
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError("Unsafe archive member")
        stream.extractall(source, filter="data")
    config = scratch / "config"
    config.mkdir()
    (config / "empty.npmrc").write_text("")
    env = {
        "PATH": os.environ.get("PATH", os.defpath), "CI": "1", "NO_COLOR": "1",
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TERM": "dumb",
        "XDG_CONFIG_HOME": str(config), "XDG_CACHE_HOME": str(scratch / "cache"),
        "BUN_INSTALL_CACHE_DIR": str(scratch / "bun-cache"),
        "NPM_CONFIG_USERCONFIG": str(config / "empty.npmrc"),
        "UV_CACHE_DIR": str(scratch / "uv-cache"), "UV_PYTHON_DOWNLOADS": "never",
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
    }
    report = {
        "recordedAt": datetime.now(timezone.utc).isoformat(), "sourceCommit": commit,
        "archiveSha256": sha(archive), "verifierSha256": sha(Path(__file__).read_bytes()),
        "condition": "Exact Git archive; no working-tree overlay; app builds before sibling install",
        "providerCallsRequested": False, "networkIsolated": False, "checks": [], "passed": False,
    }
    for index, (name, directory, command) in enumerate(CHECKS):
        start = time.monotonic()
        log = scratch / f"check-{index}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(command, cwd=source / "jev-experiments" / directory,
                                       env=env, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            timed_out = False
            try:
                code = process.wait(timeout=600)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                code = process.wait()
        data = log.read_bytes()
        lines = data.decode(errors="replace").splitlines()
        summaries = [line.strip() for line in lines if re.fullmatch(
            r"\s*(?:\d+ (?:pass|fail|expect\(\) calls)|=+ \d+ passed.* =+|\d+ passed(?:, \d+ skipped)? in [\d.]+s)\s*", line)]
        report["checks"].append({"name": name, "cwd": f"jev-experiments/{directory}",
            "command": command, "exitCode": code, "timedOut": timed_out,
            "elapsedSeconds": round(time.monotonic() - start, 3),
            "logSha256": sha(data), "summaries": summaries})
        print(f"{'PASS' if code == 0 else 'FAIL'}: {name}", flush=True)
        if code != 0:
            break
    report["passed"] = len(report["checks"]) == len(CHECKS) and all(
        row["exitCode"] == 0 and not row["timedOut"] for row in report["checks"])
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
