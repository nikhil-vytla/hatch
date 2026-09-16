"""Materialize original pinned data, never regenerate or silently filter tasks."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

from . import UPSTREAM_REVISION


def check_install() -> None:
    distribution = importlib.metadata.distribution("tau2")
    source = json.loads(distribution.read_text("direct_url.json") or "{}")
    if distribution.version != "1.0.1" or source.get("vcs_info", {}).get("commit_id") != UPSTREAM_REVISION:
        raise RuntimeError("tau2 must be installed from the exact pinned Git commit")


def main() -> None:
    check_install()
    source, destination, allowlist = (Path(value).absolute() for value in sys.argv[1:])
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != UPSTREAM_REVISION:
        raise RuntimeError("data checkout differs from installed tau2")
    # Include shared user simulator guidelines as well as domain tasks/db/policy.
    expected: dict[str, bytes] = {}
    for path in sorted((source / "data").rglob("*")):
        if path.is_symlink() or path.name == ".env":
            raise RuntimeError("unsafe upstream data path: " + str(path))
        if path.is_file():
            expected[path.relative_to(source / "data").as_posix()] = path.read_bytes()
    expected["qualification_assertions.json"] = allowlist.read_bytes()
    license_path = next(path for path in (source / "LICENSE", source / "LICENSE.md") if path.exists())
    expected["UPSTREAM_LICENSE"] = license_path.read_bytes()
    required = {"tau2/domains/telecom/tasks.json", "tau2/domains/telecom/split_tasks.json"}
    if not required <= expected.keys():
        raise RuntimeError("upstream data tree missing telecom inventory/splits")
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in expected.items()}
    expected["source-manifest.json"] = (json.dumps({"revision": revision, "files": manifest}, sort_keys=True, indent=2) + "\n").encode()
    if destination.exists():
        actual = {p.relative_to(destination).as_posix(): p.read_bytes() for p in destination.rglob("*") if p.is_file()}
        if actual != expected:
            raise RuntimeError("retained data differs; use a new output directory rather than replacing retained bytes")
    else:
        destination.mkdir(parents=True)
        for name, data in expected.items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o444)
    print(f"Pinned tau2 installed; retained {len(expected)} original data/license files in {destination}")


if __name__ == "__main__":
    main()
