"""Offline build/import smoke using a supplied, read-only uv archive cache.

Run with the existing project interpreter and -B. This does not replace the
legacy isolated installation tests whose uv subprocess panics on this host.
"""

import importlib
from pathlib import Path
import subprocess
import sys
import zipfile


def main() -> None:
    cache = Path(sys.argv[1])
    project = Path(__file__).resolve().parent.parent
    output = project / "milestone3-effects" / ".work" / "wheel"
    output.mkdir(parents=True, exist_ok=True)
    sys.dont_write_bytecode = True
    for package in ("hatchling", "packaging", "pathspec", "pluggy", "trove_classifiers"):
        candidates = sorted(cache.glob(f"*/{package}/__init__.py"))
        if not candidates:
            raise RuntimeError(f"missing cached build dependency: {package}")
        sys.path.insert(0, str(candidates[0].parents[1]))
    backend = importlib.import_module("hatchling.build")
    wheel = output / backend.build_wheel(str(output))
    installed = output / "installed"
    with zipfile.ZipFile(wheel) as archive:
        for name in ("_candidate.js", "_limits.py", "_memory.py", "supervisor.py", "sandbox.py", "broker.py", "ledger.py"):
            assert f"strive/vnext/runtime/{name}" in archive.namelist(), name
        assert "strive/policies/manual_change.toml" in archive.namelist()
        archive.extractall(installed)
    program = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import strive.vnext.runtime as runtime
assert Path(runtime.__file__).is_relative_to(Path(sys.argv[1]))
from strive.cli import main
sys.argv = ["strive", "sandbox"]
main()
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", program, str(installed)],
                            capture_output=True, text=True, timeout=30, check=True)
    assert "sandbox backends" in result.stdout
    print("Wheel includes M3 Python/JS resources; installed wheel imports and legacy CLI smoke pass.")


if __name__ == "__main__":
    main()
