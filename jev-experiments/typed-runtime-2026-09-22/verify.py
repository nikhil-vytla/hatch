#!/usr/bin/env python3
"""Verify an exact Git source archive; no providers, model inference or deployment."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time

BUN_VERSION = "1.3.14"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sanitize(text: str, roots: list[Path]) -> str:
    for root in sorted(roots, key=lambda x: len(str(x)), reverse=True):
        text = text.replace(str(root), "<temporary-source>")
    text = re.sub(r"https?://[^\s)\]>]+", "<url>", text)
    text = re.sub(r"(?i)(?:bearer\s+)[^\s]+", "<credential>", text)
    text = re.sub(r"\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+", "<credential>", text)
    text = re.sub(r"(?:/Users/|/home/|/private/|/var/folders/|/tmp/)[^\s:),\]}]+", "<temporary-path>", text)
    lines = text.splitlines()
    failures = [line for line in lines if re.search(r"\(fail\)|error TS\d+|^FAIL|^ERROR", line)][:12]
    return "\n".join(failures + lines[-24:])[-7000:]

def extract(archive: bytes, destination: Path) -> None:
    if any(destination.iterdir()):
        raise ValueError("Archive destination must be empty")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
        for member in source:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or "node_modules" in path.parts:
                raise ValueError("Archive contains a forbidden path")
            target = destination / path
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("Archive file is unreadable")
                target.write_bytes(stream.read())
                target.chmod(member.mode & 0o777)
            else:
                raise ValueError("Archive must contain regular files and directories only")

def run(ref: str, output: Path) -> dict:
    if output.exists():
        raise ValueError("Choose a new output directory")
    commit = subprocess.check_output(["git", "rev-parse", "--verify", ref + "^{commit}"], cwd=REPO, text=True).strip()
    tree = subprocess.check_output(["git", "rev-parse", commit + "^{tree}"], cwd=REPO, text=True).strip()
    archive = subprocess.check_output(["git", "archive", "--format=tar", commit], cwd=REPO)
    output.mkdir(parents=True)
    report = {"schemaVersion": 1, "commit": commit, "tree": tree, "archiveSha256": sha(archive),
              "condition": "Exact Git archive, empty source directory, app frozen install/build before any sibling install; authored provider-free fixtures only.",
              "checks": [], "limits": "No model inference, MLX installation, quality, performance, billing, GitHub CI or deployment claim. Duration is diagnostic check wall time."}
    with tempfile.TemporaryDirectory(prefix="jev-typed-runtime-archive-") as temporary:
        area = Path(temporary); source = area / "source"; source.mkdir()
        extract(archive, source)
        inputs = {p.relative_to(source).as_posix(): sha(p.read_bytes()) for p in sorted(source.rglob("*")) if p.is_file()}
        (output / "source.json").write_text(json.dumps({"commit": commit, "files": inputs}, indent=2) + "\n")
        report["sourceManifestSha256"] = sha((output / "source.json").read_bytes())
        env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "CI": "1", "NO_COLOR": "1", "TERM": "dumb",
               "TMPDIR": str(area), "XDG_CONFIG_HOME": str(area / "config"), "XDG_CACHE_HOME": str(area / "cache"),
               "BUN_INSTALL_CACHE_DIR": str(area / "bun-cache"), "NPM_CONFIG_USERCONFIG": os.devnull,
               "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        app = "jev-experiments/experience-prototypes"
        road = "jev-experiments/roadmap"
        adapter = "jev-experiments/adapters/typescript"
        steps = [
            ("bun-version", ["bun", "--version"], "."),
            ("app-frozen-install", ["bun", "install", "--frozen-lockfile"], app),
            ("app-build-before-siblings", ["bun", "run", "build"], app),
            ("adapter-frozen-install", ["bun", "install", "--frozen-lockfile"], adapter),
            ("toolkit-frozen-install", ["bun", "install", "--frozen-lockfile"], road),
            ("adapter-typecheck", ["bun", "x", "--no-install", "tsc", "--noEmit"], adapter),
            ("toolkit-typecheck", ["bun", "run", "check"], road),
            ("native-runtime-toolkit-tests", ["bun", "test", "jev-experiments/packages/decision-runtime", road + "/runtime", road + "/routing", adapter + "/index.test.ts", "jev-experiments/gateway-accounting-2026-09-22"], "."),
            ("python-local-contract-tests", ["python3", "-m", "unittest", "discover", "-s", road + "/mac", "-p", "test_*.py"], "."),
            ("fresh-installed-cli-mcp", ["python3", road + "/routing/fresh_install.py", "--output", str(area / "installed.json")], "."),
        ]
        for name, command, cwd in steps:
            started = time.monotonic()
            before_siblings = not any((source / folder / "node_modules").exists() for folder in [road, adapter])
            child_env = dict(env)
            if name == "native-runtime-toolkit-tests":
                child_env["JEV_CLASSIFIER_CHECK_REPORT"] = str(area / "classifier-fixtures.jsonl")
            process = subprocess.Popen(command, cwd=source / cwd, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            timeout = False
            try:
                raw, _ = process.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                timeout = True; os.killpg(process.pid, signal.SIGKILL); raw, _ = process.communicate()
            text = raw.decode("utf-8", "replace")
            passed = process.returncode == 0 and not timeout
            if name == "bun-version":
                passed = passed and text.strip() == BUN_VERSION
            if name == "app-build-before-siblings":
                passed = passed and before_siblings
            row = {"name": name, "command": [sanitize(arg, [area, source, REPO]) for arg in command], "cwd": cwd,
                   "exitCode": process.returncode, "passed": passed, "timeout": timeout, "seconds": round(time.monotonic() - started, 3),
                   "output": sanitize(text, [area, source, REPO])}
            if name == "app-build-before-siblings": row["siblingDependenciesAbsent"] = before_siblings
            report["checks"].append(row)
            (output / "checks.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps({k: row[k] for k in ["name", "exitCode", "passed"]}), flush=True)
            if name == "bun-version" and not passed: break
        for name in ["installed.json", "classifier-fixtures.jsonl"]:
            path = area / name
            if path.exists():
                # Maintained check output is authored data with relative source hashes.
                shutil.copyfile(path, output / name)
        changed = [name for name, digest in inputs.items() if not (source / name).is_file() or sha((source / name).read_bytes()) != digest]
        report["sourceUnchanged"] = not changed
        report["changedSourcePaths"] = changed
        report["passed"] = len(report["checks"]) == len(steps) and all(row["passed"] for row in report["checks"]) and not changed
        report["artifacts"] = {p.name: sha(p.read_bytes()) for p in sorted(output.iterdir()) if p.name != "checks.json" and p.is_file()}
        (output / "checks.json").write_text(json.dumps(report, indent=2) + "\n")
        return report

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = run(args.ref, args.output.resolve())
    print(json.dumps({"commit": result["commit"], "passed": result["passed"], "checks": len(result["checks"])}))
    raise SystemExit(0 if result["passed"] else 1)
