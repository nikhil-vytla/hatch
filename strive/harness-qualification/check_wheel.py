"""Offline wheel check; does not replace the legacy isolated-install tests."""
import importlib
from pathlib import Path
import subprocess
import sys
import zipfile


def main() -> None:
    cache = Path(sys.argv[1])
    output = Path(__file__).resolve().parent / ".scratch" / "wheel"
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
        for name in ("provider", "gateway", "http_gateway", "bridge", "execution", "process", "process_identity", "profiles", "decoding"):
            assert f"strive/vnext/harness/{name}.py" in archive.namelist(), name
        for name in ("base", "opencode", "codex", "claude_code"):
            assert f"strive/vnext/harness/adapters/{name}.py" in archive.namelist(), name
        archive.extractall(installed)
    program = '''
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import strive.vnext.harness.adapters as adapters
assert Path(adapters.__file__).is_relative_to(Path(sys.argv[1]))
assert set(adapters.REGISTRY) == {"opencode", "codex", "claude-code"}
from strive.cli import main
sys.argv = ["strive", "sandbox"]
main()
'''
    result = subprocess.run([sys.executable, "-I", "-B", "-c", program, str(installed)],
                            capture_output=True, text=True, timeout=30, check=True)
    assert "sandbox backends" in result.stdout
    print("Wheel contains all harness modules; installed adapter imports and legacy CLI smoke pass.")


if __name__ == "__main__":
    main()
