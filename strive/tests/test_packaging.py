"""The built artifact is real. We BUILD the wheel, INSTALL it into an isolated
virtual environment, and invoke the ACTUAL installed `strive` console script —
build/install failures FAIL the test (they are never skipped). We also assert
the wheel ships the policy package data (frozen TOML config + versioned prompt).
"""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path


def _run(*argv: str, timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout)


def test_wheel_ships_package_data(tmp_path: Path) -> None:
    project = Path(__file__).resolve().parent.parent
    out = tmp_path / "dist"
    built = _run("uv", "build", "--wheel", "-o", str(out))
    assert built.returncode == 0, f"wheel build FAILED: {built.stderr[-500:]}"
    wheels = list(out.glob("*.whl"))
    assert wheels, "no wheel produced"
    with zipfile.ZipFile(wheels[0]) as zf:
        names = zf.namelist()
        entry_points = next(
            (zf.read(n).decode("utf-8") for n in names if n.endswith("entry_points.txt")),
            "",
        )
    assert any(n.endswith("strive/policies/manual_change.toml") for n in names), names
    assert any(n.endswith("manual_change_refine@1.md") for n in names), names
    assert "strive = strive.cli:main" in entry_points, entry_points


def test_installed_console_script_runs_in_isolated_env(tmp_path: Path) -> None:
    project = Path(__file__).resolve().parent.parent
    out = tmp_path / "dist"
    built = _run("uv", "build", "--wheel", "-o", str(out))
    assert built.returncode == 0, f"wheel build FAILED: {built.stderr[-500:]}"
    wheel = next(iter(out.glob("*.whl")))

    venv = tmp_path / "venv"
    made = _run("uv", "venv", str(venv))
    assert made.returncode == 0, f"venv create FAILED: {made.stderr[-500:]}"

    installed = _run("uv", "pip", "install", "--python", str(venv), str(wheel))
    assert installed.returncode == 0, f"wheel install FAILED: {installed.stderr[-800:]}"

    script = venv / ("Scripts" if sys.platform == "win32" else "bin") / "strive"
    # the ACTUAL installed console script, run end to end
    ran = _run(str(script), "sandbox")
    assert ran.returncode == 0, f"strive sandbox FAILED: {ran.stderr[-500:]}"
    assert "sandbox backends" in ran.stdout

    # and a real run through the installed script over a temp artifact root
    root = tmp_path / "artifacts"
    did_run = _run(str(script), "--root", str(root), "run", "--seed", "1")
    assert did_run.returncode == 0, f"strive run FAILED: {did_run.stderr[-500:]}"
    assert "manual change complete" in did_run.stdout
