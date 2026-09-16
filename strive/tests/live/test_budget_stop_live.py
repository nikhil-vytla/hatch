"""Explicit opt-in paid acceptance. Never runs on the host or in ordinary CI."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.skipif(sys.platform != "linux" or not os.environ.get("OPENAI_API_KEY")
                    or os.environ.get("STRIVE_RUN_LIVE_BUDGET_PROOF") != "1",
                    reason="paid proof requires explicit orchestrator opt-in, Linux and OPENAI_API_KEY")
def test_budget_stop_live(tmp_path: Path) -> None:
    assert Path("/.dockerenv").is_file() or Path("/run/.containerenv").is_file(), "paid proof must run in the orchestrator container"
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([sys.executable, "-m", "strive.vnext.cli", "--root", str(tmp_path), "budget-stop-live",
        str(root / "live-tau2-budget-proof/budget-stop-5c.toml"), "--id", "live-proof"],
        capture_output=True, text=True, timeout=7200)
    assert result.returncode == 0, result.stdout + result.stderr
    proof = json.loads((tmp_path / "runs/live-proof/budget-proof.json").read_text())
    assert proof["status"] == "passed" and proof["live"] is True
    assert 0 < proof["settled_usd"] <= 0.05
    assert proof["dispatches_after_stop"] == proof["overrun_usd"] == 0
