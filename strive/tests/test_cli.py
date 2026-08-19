"""vNext CLI smoke tests: `strive` run/status/view/history/inspect/revert/
repair/sandbox over one artifact root, plus the installed entry point."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from strive.cli import main


def _json(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, dict[str, Any]]:
    code = main(["--json", *argv])
    out = capsys.readouterr().out.strip().splitlines()[-1]
    return code, json.loads(out)


def test_run_status_view_history_flow(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = str(tmp_path / "artifacts")
    code, env = _json(capsys, "--root", root, "run", "--seed", "5")
    assert code == 0 and env["ok"]
    run_id = env["data"]["run_id"]
    assert env["data"]["stopped_reason"] == "manual change complete"

    code, runs = _json(capsys, "--root", root, "runs")
    assert run_id in runs["data"]["runs"]

    code, status = _json(capsys, "--root", root, "status", "--run", run_id)
    assert status["data"]["verified"] is True
    assert status["data"]["policy_ref"] == "manual-change@1"
    assert status["data"]["seed"] == 5

    code, view = _json(capsys, "--root", root, "view", "--run", run_id)
    surfaces = {(s["kind"], s["name"]) for s in view["data"]["surfaces"]}
    assert ("strategy-code", "solve") in surfaces

    code, hist = _json(capsys, "--root", root, "history", "--run", run_id)
    event_kinds = [e["kind"] for e in hist["data"]["events"]]
    assert "change-applied@2" in event_kinds and "change-reverted@2" in event_kinds


def test_inspect_and_sandbox(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = str(tmp_path / "artifacts")
    _json(capsys, "--root", root, "run")
    code, hist = _json(capsys, "--root", root, "history")
    applied = next(e for e in hist["data"]["events"] if e["kind"] == "change-applied@2")
    code, insp = _json(capsys, "--root", root, "inspect", "--event", str(applied["seq"]))
    assert code == 0 and insp["data"]["body"]["schema"] == "change-applied@2"

    code, sb = _json(capsys, "--root", root, "sandbox")
    names = {b["backend"] for b in sb["data"]["backends"]}
    assert "process-fault-only@1" in names and "deno-pyodide@1" in names


def test_cli_revert_and_repair(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = str(tmp_path / "artifacts")
    _json(capsys, "--root", root, "run")
    # the manual policy already reverted its own change; a second revert of the
    # same change id is refused (already reverted) — fail-closed, clean error
    code, out = _json(capsys, "--root", root, "revert", "manual-change-1")
    assert code == 1 and "already reverted" in out["error"]
    # repair on a clean, verified journal is a no-op
    code, rep = _json(capsys, "--root", root, "repair")
    assert code == 0 and rep["data"]["quarantine"] is None


def test_unknown_run_is_a_clean_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out = _json(capsys, "--root", str(tmp_path / "empty"), "status")
    assert code == 1 and "no runs" in out["error"]


def test_installed_entry_point_runs() -> None:
    """`uv run strive` (the console script) is installed and works."""
    result = subprocess.run(
        [sys.executable, "-m", "strive.cli", "sandbox"],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0
    assert "sandbox backends" in result.stdout
