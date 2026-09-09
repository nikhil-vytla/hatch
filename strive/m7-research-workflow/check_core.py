"""Read-only freeze audit and retained diff of modifications to tracked files."""
import hashlib
import json
from pathlib import Path
import subprocess


def main() -> None:
    folder = Path(__file__).resolve().parent
    root = folder.parent
    expected = json.loads((root / "m5-investigation/second-benchmark-core-freeze.json").read_text())
    files = {name: {"expected": digest, "actual": hashlib.sha256((root / name).read_bytes()).hexdigest()}
             for name, digest in expected.items()}
    matched = sum(row["expected"] == row["actual"] for row in files.values())
    result = {"matching": matched, "total": len(files), "files": files}
    (folder / "core-integrity.json").write_text(json.dumps(result, indent=2) + "\n")
    diff = subprocess.run(["git", "-c", "core.fsmonitor=false", "diff", "--", "src", "tests"],
                          cwd=root, check=True, capture_output=True).stdout
    (folder / "existing-changes.diff").write_bytes(diff)
    core = subprocess.run(["git", "-c", "core.fsmonitor=false", "diff", "--", *expected,
                           "src/strive/vnext/harness/gateway.py"], cwd=root, check=True, capture_output=True).stdout
    (folder / "core.diff").write_bytes(core)
    assert matched == len(files) == 30 and not core
    print(f"{matched}/{len(files)} frozen hashes match; frozen core and gateway diff empty")


if __name__ == "__main__":
    main()
