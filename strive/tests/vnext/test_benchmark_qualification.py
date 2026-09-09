from copy import deepcopy
from pathlib import Path

import pytest

from strive.vnext.benchmarks.closure import REQUIRED, retain_closure, verify_closure
from strive.vnext.benchmarks.json_data import canonical, obj
from strive.vnext.errors import VerificationError
from strive.vnext.store import ArtifactStore
from strive_benchmark_tau2.qualification import QualificationFailure, qualify

from .benchmark_fixtures import inventory


def test_full_fixture_inventory_and_deterministic_whole_group_partition(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    # Non-base pools are scanned too.
    extra = deepcopy(tasks[0]); extra["id"] = "extra"
    tasks.append(extra); splits["additional"] = ["extra"]
    tasks[1]["user_scenario"] = tasks[0]["user_scenario"]
    called: list[str] = []
    def check(task: dict[str, object]) -> None:
        called.append(str(task["id"]))
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}), execute_checks=check)
    assert len(called) == 115
    assert len(result.development) == 60 and len(result.validation) == 14 and len(result.audit) == 40
    assert any(set(group) == {"0", "1", "extra"} for group in result.groups)
    again = qualify(objects, canonical(list(reversed(tasks))), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}), execute_checks=check)
    assert (result.groups, result.development, result.validation, result.audit) == (again.groups, again.development, again.validation, again.audit)
    for group in result.groups:
        assert not (set(group) & set(result.development) and set(group) & set(result.validation))


@pytest.mark.parametrize("case,affected", [("nl", "0"), ("unknown", "0"), ("assertion", "0"), ("missing_criteria", "0"),
    ("duplicate", "0"), ("missing", "missing"), ("crossing", "74"), ("partition", "0"), ("gold", "0"), ("extra_nl", "extra")])
def test_qualification_hard_stops_with_exact_ids(tmp_path: Path, case: str, affected: str) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    checks = lambda task: None
    criteria = obj(tasks[0]["evaluation_criteria"])
    if case in {"nl", "unknown"}:
        criteria["reward_basis"] = ["NL_ASSERTION" if case == "nl" else "UNKNOWN"]
        tasks[0]["evaluation_criteria"] = criteria
    elif case == "assertion":
        criteria["env_assertions"] = [{"env_type": "user", "func_name": "random_assertion"}]
        tasks[0]["evaluation_criteria"] = criteria
    elif case == "missing_criteria":
        tasks[0]["evaluation_criteria"] = None
    elif case == "duplicate":
        tasks.append(deepcopy(tasks[0]))
    elif case == "missing":
        splits["additional"] = ["missing"]
    elif case == "crossing":
        tasks[74]["initial_state"] = tasks[0]["initial_state"]
        tasks[74]["evaluation_criteria"] = tasks[0]["evaluation_criteria"]
    elif case == "partition":
        for task in tasks[:74]:
            task["user_scenario"] = {"instructions": "same scenario", "persona": task["id"]}
    elif case == "gold":
        def failing(task: dict[str, object]) -> None:
            if task["id"] == "0":
                raise VerificationError("gold action failed")
        checks = failing
    elif case == "extra_nl":
        extra = deepcopy(tasks[0]); extra["id"] = "extra"
        extra["evaluation_criteria"] = {"reward_basis": ["NL_ASSERTION"]}
        tasks.append(extra)
        splits["additional"] = ["extra"]
    with pytest.raises(QualificationFailure) as raised:
        qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}), execute_checks=checks)
    assert affected in raised.value.affected_ids
    assert "60/14/40" in raised.value.proposed_campaign
    assert splits["base"] == [str(i) for i in range(114)]


def test_connected_transitive_groups(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    tasks[1]["user_scenario"] = tasks[0]["user_scenario"]
    tasks[2]["initial_state"] = tasks[1]["initial_state"]
    tasks[2]["evaluation_criteria"] = tasks[1]["evaluation_criteria"]
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}), execute_checks=lambda task: None)
    assert ("0", "1", "2") in result.groups


@pytest.mark.parametrize("category_to_corrupt", ["tasks", "policies", "scorer", "dependencies"])
def test_retained_closure_detects_altered_bytes(tmp_path: Path, category_to_corrupt: str) -> None:
    store = ArtifactStore(tmp_path / "cas")
    paths: dict[str, tuple[Path, ...]] = {}
    for category in REQUIRED:
        path = tmp_path / (category + ".fixture")
        path.write_text(category)
        paths[category] = (path,)
    closure = retain_closure(store.objects, paths)
    verify_closure(store.objects, closure)
    ref = store.objects.publish(category_to_corrupt.encode())
    store.objects.path(ref).write_bytes(b"changed policy")
    with pytest.raises(VerificationError, match="corrupted"):
        verify_closure(store.objects, closure)


def test_materialized_data_requires_exact_retained_bytes(tmp_path: Path) -> None:
    from strive_benchmark_tau2.data import retain_data, verify_data
    objects = ArtifactStore(tmp_path / "objects").objects
    source = tmp_path / "source"; source.mkdir()
    (source / "policy.md").write_text("retained policy")
    target = tmp_path / "retained"
    index = retain_data(objects, source, target)
    verify_data(objects, index, target)
    (target / "policy.md").chmod(0o644)
    (target / "policy.md").write_text("altered policy")
    with pytest.raises(VerificationError, match="changed"):
        verify_data(objects, index, target)
