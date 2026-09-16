from copy import deepcopy
from itertools import product
from pathlib import Path

import pytest

from strive.benchmarks.closure import REQUIRED, retain_closure, verify_closure
from strive.benchmarks.json_data import canonical, items, obj, parse
from strive.errors import VerificationError
from strive.store import ArtifactStore
from strive_benchmark_tau2.qualification import QualificationFailure, qualify, load_qualification
from strive_benchmark_tau2.splits import group_tasks, scenario_group, size_error, validate_partition, whole_group_split

from .benchmark_fixtures import inventory

ALLOWLIST = frozenset({("user", "connected")})


def test_full_fixture_inventory_and_deterministic_whole_group_partition(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    extra = deepcopy(tasks[0]); extra["id"] = "extra"
    tasks.append(extra); splits["additional"] = ["extra"]
    tasks[1]["user_scenario"] = tasks[0]["user_scenario"]
    called: list[str] = []
    def check(task: dict[str, object]) -> None:
        called.append(str(task["id"]))
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=check)
    assert set(called) == set(splits["base"]) and len(called) == 114
    assert tuple(map(len, (result.development, result.validation, result.audit))) == (60, 14, 40)
    assert any(set(group) == {"0", "1", "extra"} for group in result.groups)
    again = qualify(objects, canonical(list(reversed(tasks))), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=check)
    assert (result.groups, result.development, result.validation, result.audit) == (again.groups, again.development, again.validation, again.audit)
    validate_partition(result.groups, set(splits["base"]), (result.development, result.validation, result.audit))
    assert load_qualification(objects, result.report) == result
    details = obj(parse(objects.read(result.details)))
    assert details["exact_target_achievable"] is True
    assert details["split_origin"] == "strive-derived-base"
    assert details["leaderboard_comparability"] == "none"


@pytest.mark.parametrize("case,affected", [("nl", "0"), ("diagnostic_nl", "0"), ("unknown", "0"), ("assertion", "0"),
    ("missing_criteria", "0"), ("duplicate", "0"), ("missing", "missing"), ("gold", "0")])
def test_qualification_hard_stops_with_exact_ids(tmp_path: Path, case: str, affected: str) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    checks = lambda task: None
    criteria = obj(tasks[0]["evaluation_criteria"])
    if case in {"nl", "unknown", "diagnostic_nl"}:
        if case == "diagnostic_nl":
            criteria["nl_assertions"] = ["ask an LLM"]
        else:
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
    elif case == "gold":
        def failing(task: dict[str, object]) -> None:
            if task["id"] == "0":
                raise VerificationError("gold action failed")
        checks = failing
    with pytest.raises(QualificationFailure) as raised:
        qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=checks)
    assert affected in raised.value.affected_ids
    assert "60/14/40" in raised.value.proposed_campaign
    assert splits["base"] == [str(i) for i in range(114)]


def test_stock_overlap_and_unselected_grading_are_informational(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    tasks[74]["user_scenario"] = tasks[0]["user_scenario"]
    extra = deepcopy(tasks[0]); extra["id"] = "extra"
    extra["evaluation_criteria"] = {"reward_basis": ["NL_ASSERTION"]}
    tasks.append(extra); splits["additional"] = ["extra"]
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=lambda task: None)
    details = obj(parse(objects.read(result.details)))
    for key in ("stock_split_cross_group", "stock_split_legacy_cross_group"):
        overlap = obj(details[key])
        assert overlap["severity"] == "informational" and overlap["fatal"] is False
        assert overlap["inventory_id_count"] == 3
        assert set(items(overlap["ids"])) == {"0", "74", "extra"}
    assert obj(details["unselected_grading_findings"])["failures"]
    assert details["status"] == "qualified"
    validate_partition(result.groups, set(splits["base"]), (result.development, result.validation, result.audit))


def test_groups_do_not_merge_through_goals_or_similarity(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    tasks[1]["user_scenario"] = tasks[0]["user_scenario"]
    tasks[2]["initial_state"] = tasks[1]["initial_state"]
    tasks[2]["evaluation_criteria"] = tasks[1]["evaluation_criteria"]
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=lambda task: None)
    assert ("0", "1") in result.groups
    assert ("2",) in result.groups


def test_generated_base_templates_normalize_all_composition_and_persona_variants() -> None:
    variants = ["[mms_issue]bad_wifi_calling[PERSONA:None]",
                "[mms_issue]airplane_mode_on|bad_wifi_calling[PERSONA:Easy]",
                "[mms_issue]bad_wifi_calling|airplane_mode_on[PERSONA:Hard]",
                "[mms_issue]overdue_bill_suspension[PERSONA:Hard]"]
    assert {scenario_group({"id": value}) for value in variants} == {"[mms_issue]"}
    assert scenario_group({"id": "[service_issue]airplane_mode_on[PERSONA:Easy]"}) == "[service_issue]"
    with pytest.raises(VerificationError, match="unrecognized"):
        scenario_group({"id": "[mms_issue]bad[PERSONA:Easy]unexpected"})


def test_closest_nonempty_partition_keeps_all_three_real_root_groups(tmp_path: Path) -> None:
    objects = ArtifactStore(tmp_path).objects
    tasks, splits = inventory()
    names = ["mms_issue"] * 49 + ["mobile_data_issue"] * 36 + ["service_issue"] * 29
    for task, name in zip(tasks, names, strict=True):
        task["id"] = f"[{name}]condition_{task['id']}[PERSONA:None]"
    splits = {key: [str(tasks[int(i)]["id"]) for i in ids] for key, ids in splits.items()}
    result = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=ALLOWLIST, execute_checks=lambda task: None)
    assert tuple(map(len, (result.development, result.validation, result.audit))) == (49, 29, 36)
    validate_partition(result.groups, set(splits["base"]), (result.development, result.validation, result.audit))
    details = obj(parse(objects.read(result.details)))
    assert details["exact_target_achievable"] is False
    assert obj(details["gates"])["adaptive_whole_group_disjoint"] == "passed"
    assert len(obj(details["group_to_ids"])) == 3


def test_partition_optimizes_globally_and_rejects_overlapping_group_membership() -> None:
    sizes = (4, 3, 2, 2)
    groups = tuple(tuple(f"{i}-{j}" for j in range(size)) for i, size in enumerate(sizes))
    selected = {t for group in groups for t in group}
    target = (5, 2, 4)
    dev, val, audit = whole_group_split(groups, selected, target=target)
    attainable = [tuple(sum(s for s, arm in zip(sizes, assignments, strict=True) if arm == part) for part in range(3))
                  for assignments in product(range(3), repeat=len(groups)) if len(set(assignments)) == 3]
    assert size_error((len(dev), len(val), len(audit)), target) == min(size_error((s[0], s[1], s[2]), target) for s in attainable)
    with pytest.raises(VerificationError, match="exactly once"):
        whole_group_split((*groups, groups[0]), selected)
    with pytest.raises(VerificationError, match="crosses"):
        validate_partition((("a", "b"),), {"a", "b"}, (("a",), (), ("b",)))


def test_insufficient_groups_reports_empty_partition_without_dropping_tasks(tmp_path: Path) -> None:
    tasks, splits = inventory()
    for task in tasks:
        task["user_scenario"] = {"instructions": "one root", "persona": task["id"]}
    result = qualify(ArtifactStore(tmp_path).objects, canonical(tasks), canonical(splits),
                     assertion_allowlist=ALLOWLIST, execute_checks=lambda task: None)
    assert tuple(map(len, (result.development, result.validation, result.audit))) == (114, 0, 0)
    assert set(result.development) == set(splits["base"])


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
