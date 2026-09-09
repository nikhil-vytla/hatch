"""Live-upstream checks are explicit skips unless the separate runtime is ready.

These tests never install packages, download data or make model calls.
"""
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / "adapters/tau2/.venv/bin/python"
DATA = ROOT / "adapters/tau2/retained-data"
REASON = "tau2 not installed: isolated uv lock panicked in macOS system-configuration (Attempted to create a NULL object); shell DNS for raw.githubusercontent.com unavailable"
DATA_REASON = "full telecom inventory unavailable: shell DNS failed for raw.githubusercontent.com; web reader rejected tasks.json as larger than 4MB; full-inventory certification outstanding"


@pytest.mark.skipif(not PYTHON.exists(), reason=REASON)
def test_live_tau2_action_comparator_equivalence() -> None:
    program = '''
from tau2.data_model.tasks import Action
from tau2.data_model.message import ToolCall
cases = [(None, {}, True), ([], {"x": 9}, True), (None, {"x": 1}, True), (None, {"x": 2}, False)]
for compare, arguments, expected in cases:
    action = Action(action_id="reference", name="transfer", arguments={"x": 1, "y": 2}, compare_args=compare)
    call = ToolCall(id="call", name="transfer", arguments=arguments, requestor="user")
    assert action.compare_with_tool_call(call) is expected
'''
    result = subprocess.run([str(PYTHON), "-I", "-B", "-c", program], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not (DATA / "tau2/domains/telecom/tasks.json").exists(), reason=DATA_REASON)
def test_full_inventory_certification(tmp_path: Path) -> None:
    # A real certificate must include executed initialization/gold/assertion
    # checks, so data presence alone cannot turn this into a passing test.
    if not PYTHON.exists():
        pytest.skip(REASON)
    result = subprocess.run([str(PYTHON), "-I", "-B", "-m", "strive_benchmark_tau2.certify", str(DATA), str(tmp_path / "certificate")],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not PYTHON.exists(), reason=REASON)
@pytest.mark.skipif(not (DATA / "tau2/domains/telecom/tasks.json").exists(), reason=DATA_REASON)
def test_live_tau2_initial_snapshot_and_deterministic_scorer() -> None:
    import json
    import os
    task_source = json.loads((DATA / "tau2/domains/telecom/tasks.json").read_text())
    tasks = task_source["tasks"] if isinstance(task_source, dict) else task_source
    splits = json.loads((DATA / "tau2/domains/telecom/split_tasks.json").read_text())
    task = next(task for task in tasks if task["id"] == splits["base"][0])
    script = ROOT / "adapters/tau2/src/strive_benchmark_tau2/native_worker.py"
    def call(operation: str, state: object, payload: object) -> dict[str, object]:
        result = subprocess.run([str(PYTHON), "-I", "-B", str(script)], input=json.dumps({"operation": operation, "state": state, "payload": payload}),
            capture_output=True, text=True, timeout=60, cwd=DATA, env={"TAU2_DATA_DIR": str(DATA)})
        assert result.returncode == 0, result.stderr
        value: dict[str, object] = json.loads(result.stdout)
        return value
    initial = call("initialize", None, {"task": task, "initialization": {}, "identities": {}})
    snapshot = call("snapshot", initial["state"], {})
    for key in ("agent_db", "user_db", "user_state", "agent_history", "user_history", "random_state"):
        assert isinstance(initial["state"], dict) and isinstance(snapshot["state"], dict)
        assert initial["state"][key] == snapshot["state"][key]
    terminated = call("terminate", snapshot["state"], "agent_stop")
    scored = call("score", terminated["state"], {"task": task, "termination": "agent_stop"})
    assert isinstance(scored["output"], dict)
    assert scored["output"]["status"] == "scored"
    assert scored["output"]["value"] == scored["output"]["upstream"]
