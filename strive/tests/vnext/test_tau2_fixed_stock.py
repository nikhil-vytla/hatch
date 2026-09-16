"""Host execution checks for the fixed stock runner; no upstream imports/models."""
from copy import deepcopy
from pathlib import Path

import pytest

from strive.benchmarks.json_data import canonical, obj, parse
from strive.errors import VerificationError
from strive.store import ArtifactStore
from strive_benchmark_tau2.fixed_stock import USER_MODEL, USER_TEMPERATURE, configuration, run_fixed_stock
from strive_benchmark_tau2.qualification import QualificationFailure, qualify
from .benchmark_fixtures import inventory

INITIAL = canonical({"schema": "strive.initial-tau2-actor/1", "agent": "llm_agent", "model": "initial-test-model",
                     "model_settings": {"temperature": 0}})
ALLOWLIST = frozenset({("user", "connected")})


def test_stock_mode_runs_initial_actor_on_all_stock_test_tasks(tmp_path: Path) -> None:
    tasks, splits = inventory()
    tasks[74]["user_scenario"] = tasks[0]["user_scenario"]
    # A training-only NL task cannot block this independently fixed test run.
    tasks[0]["evaluation_criteria"] = {"reward_basis": ["NL_ASSERTION"]}
    store = ArtifactStore(tmp_path / "cas")
    checked: list[str] = []
    qualification = qualify(store.objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST,
                            execute_checks=lambda task: checked.append(str(task["id"])), mode="fixed-stock")
    assert qualification.audit == tuple(splits["test"])
    assert set(checked) == set(splits["test"]) and len(checked) == 40
    def execute(config: dict[str, object], selected: list[dict[str, object]], output: Path) -> dict[str, object]:
        assert [task["id"] for task in selected] == splits["test"]
        assert config["llm_agent"] == "initial-test-model"
        assert config["llm_user"] == USER_MODEL
        assert config["llm_args_user"] == {"temperature": USER_TEMPERATURE}
        assert config["auto_resume"] is False and config["auto_review"] is False
        # Attempted executor mutations cannot alter the retained plan or source.
        config["llm_agent"] = "changed"
        selected[0]["user_scenario"] = "mutated"
        return {"simulations": [{"task_id": t, "trial": trial, "reward_info": {"reward": int(trial == 0)}}
                                for t in splits["test"] for trial in range(2)]}
    result = run_fixed_stock(store, qualification, INITIAL, tmp_path / "fixed", trials=2, execute=execute)
    assert result["simulations"] == 80 and result["mean_success"] == 0.5
    assert result["actor_selection"] == "initial" and result["adaptation_enabled"] is False
    assert result["group_disjointness_gate"] is False
    assert obj(result["config"])["llm_agent"] == "initial-test-model"
    assert store.objects.read(qualification.inventory) == canonical(tasks)
    assert obj(parse((tmp_path / "fixed/fixed-stock-result.json").read_bytes()))["status"] == "completed"
    with pytest.raises(VerificationError, match="already exist"):
        run_fixed_stock(store, qualification, INITIAL, tmp_path / "fixed", trials=2, execute=execute)


@pytest.mark.parametrize("grading", ["nl", "unknown", "assertion", "gold"])
def test_stock_mode_keeps_selected_grading_blocking(tmp_path: Path, grading: str) -> None:
    tasks, splits = inventory()
    criteria = deepcopy(obj(tasks[74]["evaluation_criteria"]))
    if grading in {"nl", "unknown"}:
        criteria["reward_basis"] = ["NL_ASSERTION" if grading == "nl" else "unknown"]
    if grading == "assertion":
        criteria["env_assertions"] = [{"env_type": "user", "func_name": "random"}]
    tasks[74]["evaluation_criteria"] = criteria
    def check(task: dict[str, object]) -> None:
        if grading == "gold":
            raise VerificationError("gold replay failed")
    with pytest.raises(QualificationFailure) as raised:
        qualify(ArtifactStore(tmp_path).objects, canonical(tasks), canonical(splits),
                assertion_allowlist=ALLOWLIST, execute_checks=check, mode="fixed-stock")
    assert "74" in raised.value.affected_ids


def test_fixed_runner_rejects_adaptive_certificate_and_incomplete_trials(tmp_path: Path) -> None:
    tasks, splits = inventory()
    store = ArtifactStore(tmp_path / "cas")
    adaptive = qualify(store.objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=lambda task: None)
    with pytest.raises(VerificationError, match="own fixed-stock certificate"):
        run_fixed_stock(store, adaptive, INITIAL, tmp_path / "wrong")
    fixed = qualify(store.objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST,
                    execute_checks=lambda task: None, mode="fixed-stock")
    with pytest.raises(VerificationError, match="omits"):
        run_fixed_stock(store, fixed, INITIAL, tmp_path / "incomplete", execute=lambda *args: {"simulations": []})
    result = obj(parse((tmp_path / "incomplete/fixed-stock-result.json").read_bytes()))
    assert result["status"] == "incomplete" and result["performance_measured"] is False


def test_prepare_does_not_dispatch_and_actor_settings_are_explicit(tmp_path: Path) -> None:
    tasks, splits = inventory()
    store = ArtifactStore(tmp_path / "cas")
    fixed = qualify(store.objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST,
                    execute_checks=lambda task: None, mode="fixed-stock")
    def never(*args: object) -> dict[str, object]:
        raise AssertionError("preparation cannot dispatch")
    report = run_fixed_stock(store, fixed, INITIAL, tmp_path / "prepared", execute=never, prepare_only=True)
    assert report["status"] == "prepared" and report["expected_simulations"] == 160
    bad = obj(parse(INITIAL)); bad["model_settings"] = {}
    with pytest.raises(VerificationError, match="temperature"):
        configuration(canonical(bad), trials=1, seed=300)
    bad["agent"] = "learned-agent"
    with pytest.raises(VerificationError, match="initial"):
        configuration(canonical(bad), trials=1, seed=300)


def test_fixed_runner_rejects_duplicate_trial_identities(tmp_path: Path) -> None:
    tasks, splits = inventory()
    store = ArtifactStore(tmp_path / "cas")
    fixed = qualify(store.objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST,
                    execute_checks=lambda task: None, mode="fixed-stock")
    def duplicate(*args: object) -> dict[str, object]:
        return {"simulations": [{"task_id": task, "trial": 0, "reward_info": {"reward": 1}}
                                for task in splits["test"] for _ in range(2)]}
    with pytest.raises(VerificationError, match="duplicate"):
        run_fixed_stock(store, fixed, INITIAL, tmp_path / "fixed", trials=2, execute=duplicate)
