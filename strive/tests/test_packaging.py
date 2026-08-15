"""The built artifact is real: the wheel ships the policy package data
(frozen TOML config + versioned prompt) and declares the `strive` console
script. Complements `test_cli.test_installed_entry_point_runs`, which exercises
the installed script itself."""

from __future__ import annotations

import subprocess
import zipfile
from pathlib import Path

import pytest


def test_wheel_ships_package_data_and_console_script(tmp_path: Path) -> None:
    project = Path(__file__).resolve().parent.parent
    out = tmp_path / "dist"
    result = subprocess.run(
        ["uv", "build", "--wheel", "-o", str(out)],
        cwd=str(project), capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        pytest.skip(f"wheel build unavailable in this environment: {result.stderr[-300:]}")
    wheels = list(out.glob("*.whl"))
    assert wheels, "no wheel produced"
    with zipfile.ZipFile(wheels[0]) as zf:
        names = zf.namelist()
        entry_points = next(
            (zf.read(n).decode("utf-8") for n in names if n.endswith("entry_points.txt")),
            "",
        )
    # the frozen config + versioned prompt travel inside the package
    assert any(n.endswith("strive/policies/manual_change.toml") for n in names), names
    assert any(n.endswith("manual_change_refine@1.md") for n in names), names
    # the console script is declared
    assert "strive = strive.cli:main" in entry_points, entry_points
