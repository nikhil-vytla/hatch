"""Run live upstream tests whenever the isolated tau2 installation is present.

Missing packages skip on the host. An installed but broken pin/data/protocol
fails visibly. Tests never install packages, download data or call models.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("TAU2_DATA_DIR", str(ROOT / "adapters/tau2/retained-data")))
RECORDINGS = ROOT / "tests/vnext/fixtures/tau2_recorded_generations.json"


@pytest.fixture(scope="module")
def tau2_python() -> Path:
    if sys.platform != "linux":
        pytest.skip("live tau2 checks run only in the Linux verification container")
    configured = os.environ.get("STRIVE_TAU2_PYTHON")
    isolated = ROOT / "adapters/tau2/.venv/bin/python"
    python = Path(configured) if configured else isolated if isolated.exists() else Path(sys.executable)
    result = subprocess.run([str(python), "-I", "-B", "-c", '''
import importlib.metadata, sys
try:
    importlib.metadata.distribution("tau2")
except importlib.metadata.PackageNotFoundError:
    sys.exit(73)
from strive_benchmark_tau2.prepare import check_install
check_install()
'''], capture_output=True, text=True, timeout=30)
    if result.returncode == 73:
        reason = "tau2 is absent from the isolated interpreter; run scripts/install-tau2.sh in Linux"
        if os.environ.get("STRIVE_REQUIRE_TAU2") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    assert result.returncode == 0, result.stderr
    assert (DATA / "tau2/domains/telecom/tasks.json").is_file(), "tau2 installed but retained task data missing; run scripts/install-tau2.sh"
    return python


def environment() -> dict[str, str]:
    return {"TAU2_DATA_DIR": str(DATA), "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1",
            "LITELLM_LOCAL_MODEL_COST_MAP": "True", "PATH": "/usr/local/bin:/usr/bin:/bin"}


def live_check(python: Path, mode: str, output: Path) -> None:
    result = subprocess.run([str(python), "-I", "-B", "-m", "strive_benchmark_tau2.live_checks", mode,
        str(output), str(RECORDINGS)], capture_output=True, text=True, timeout=300, cwd=DATA, env=environment())
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    print(result.stdout)


def test_live_tau2_action_comparator_equivalence(tau2_python: Path, tmp_path: Path) -> None:
    live_check(tau2_python, "comparator", tmp_path)


def test_full_inventory_certification(tau2_python: Path, tmp_path: Path) -> None:
    output = Path(os.environ.get("STRIVE_RESULTS", str(tmp_path))) / "tau2-certificate"
    result = subprocess.run([str(tau2_python), "-I", "-B", "-m", "strive_benchmark_tau2.certify", str(DATA), str(output)],
        capture_output=True, text=True, timeout=1800, cwd=DATA, env=environment())
    assert result.returncode == 0, result.stdout + "\n" + result.stderr  # Includes every offending task ID.
    certificate = json.loads((output / "qualification.json").read_text())
    source = json.loads((DATA / "tau2/domains/telecom/tasks.json").read_text())
    tasks = source["tasks"] if isinstance(source, dict) else source
    assert certificate["status"] == "qualified"
    assert certificate["checked_records"] == 114
    assert certificate["inventory_records"] == len(tasks)
    assert certificate["gates"]["deterministic_grading"] == "passed"
    assert certificate["gates"]["adaptive_whole_group_disjoint"] == "passed"
    assert len({task["id"] for task in tasks}) == len(tasks)
    splits = json.loads((DATA / "tau2/domains/telecom/split_tasks.json").read_text())
    dev, validation, audit = (set(certificate[name]) for name in ("development", "validation", "audit"))
    assert (len(dev), len(validation), len(audit)) == (49, 29, 36)
    assert certificate["exact_target_achievable"] is False
    assert certificate["target_sizes"] == {"development": 60, "validation": 14, "audit": 40}
    assert not dev & validation and not (dev | validation) & audit
    assert dev | validation | audit == set(splits["base"])
    assert all(sum(bool(set(group) & part) for part in (dev, validation, audit)) <= 1 for group in certificate["groups"])
    assert certificate["mode"] == "adaptive" and certificate["leaderboard_comparability"] == "none"
    assert set(certificate["group_to_ids"]) == {"[mms_issue]", "[mobile_data_issue]", "[service_issue]"}
    for name in ("stock_split_cross_group", "stock_split_legacy_cross_group"):
        info = certificate[name]
        assert info["severity"] == "informational" and info["fatal"] is False
        assert info["inventory_id_count"] == len(info["ids"]) == 2285
        assert info["stock_train_id_count"] == 74 and info["stock_test_id_count"] == 40
    selected = [task for task in tasks if task["id"] in dev | validation | audit]
    for task in selected:
        criteria = task["evaluation_criteria"]
        assert criteria["reward_basis"] and set(criteria["reward_basis"]) <= {"DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE"}
        assert not criteria.get("nl_assertions")
    print(json.dumps({"scanned_records": len(tasks), "actual_sizes": certificate["actual_sizes"],
                      "stock_overlap_informational": certificate["stock_split_legacy_cross_group"]["inventory_id_count"]}))


def test_live_tau2_deterministic_scorer_against_upstream(tau2_python: Path, tmp_path: Path) -> None:
    live_check(tau2_python, "equivalence", tmp_path)


def test_live_tau2_operation_store_snapshot_and_crash_recovery(tau2_python: Path, tmp_path: Path) -> None:
    live_check(tau2_python, "integration", tmp_path)


def test_live_tau2_fixed_stock_mode(tau2_python: Path, tmp_path: Path) -> None:
    output = Path(os.environ.get("STRIVE_RESULTS", str(tmp_path))) / "tau2-fixed-stock-certificate"
    result = subprocess.run([str(tau2_python), "-I", "-B", "-m", "strive_benchmark_tau2.certify", str(DATA), str(output),
        "--mode", "fixed-stock"], capture_output=True, text=True, timeout=1800, cwd=DATA, env=environment())
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    certificate = json.loads((output / "qualification.json").read_text())
    splits = json.loads((DATA / "tau2/domains/telecom/split_tasks.json").read_text())
    assert certificate["mode"] == "fixed-stock" and certificate["status"] == "qualified"
    assert certificate["development"] == certificate["validation"] == []
    assert certificate["audit"] == splits["test"]
    assert certificate["checked_records"] == 40
    assert certificate["gates"] == {"deterministic_grading": "passed", "adaptive_whole_group_disjoint": "not-applicable"}
    assert certificate["stock_split_legacy_cross_group"]["inventory_id_count"] == 2285
    live_check(tau2_python, "fixed-configuration", tmp_path)
