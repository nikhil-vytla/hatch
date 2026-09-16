"""Strict selected-task grading; Amendment 3 adaptive and fixed-stock modes."""
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from strive.vnext.benchmarks.json_data import canonical, items, obj, parse, string
from strive.vnext.codec import decode, encode
from strive.vnext.contracts.primitives import ArtifactRef
from strive.vnext.errors import VerificationError
from strive.vnext.store.cas import CAS
from .splits import (ALGORITHM, DEFAULT_SEED, OBJECTIVE, TARGET, crossing_report,
                     group_tasks, normalized, validate_partition, whole_group_split)

DETERMINISTIC = frozenset({"DB", "ENV_ASSERTION", "COMMUNICATE", "ACTION"})
MODES = ("adaptive", "fixed-stock")


class QualificationFailure(VerificationError):
    def __init__(self, failures: dict[str, tuple[str, ...]], details: dict[str, object]) -> None:
        self.failures, self.details = failures, details
        self.affected_ids = tuple(sorted({task for ids in failures.values() for task in ids}))
        self.proposed_campaign = (
            "Resolve selected-task grading or source integrity failures before dispatch. "
            "Do not drop tasks or weaken grading. Amendment 3 permits the closest whole-group "
            "allocation to 60/14/40; stock train/test group overlap is informational."
        )
        super().__init__(str(failures) + ". " + self.proposed_campaign)


@dataclass(frozen=True)
class Qualification:
    inventory: ArtifactRef
    source_splits: ArtifactRef
    implementation: ArtifactRef
    report: ArtifactRef
    groups: tuple[tuple[str, ...], ...]
    development: tuple[str, ...]
    validation: tuple[str, ...]
    audit: tuple[str, ...]
    mode: str
    details: ArtifactRef


def normalized_goal(value: object) -> object:
    goal = obj(value)
    result = obj(normalized(goal))
    unordered = {"reward_basis", "env_assertions", "communicate_info"}
    basis = goal.get("reward_basis")
    if isinstance(basis, list) and "DB" not in basis:
        unordered.add("actions")  # ACTION is membership, not ordered equality.
    for key in unordered:
        if isinstance(result.get(key), list):
            result[key] = sorted(items(result[key]), key=canonical)
    return result


def legacy_connected_groups(tasks: list[dict[str, object]]) -> tuple[tuple[str, ...], ...]:
    """Historical diagnostic only. Never used to assign adaptive memberships."""
    ids = [string(t["id"]) for t in tasks]
    parent = {task_id: task_id for task_id in ids}
    def root(task_id: str) -> str:
        while parent[task_id] != task_id:
            task_id = parent[task_id]
        return task_id
    seen: dict[tuple[str, bytes], str] = {}
    for task_id, task in sorted(zip(ids, tasks, strict=True), key=lambda pair: pair[0]):
        for signal, value in (("scenario", normalized(task.get("user_scenario"), persona=True)),
                              ("init-goal", [normalized(task.get("initial_state")), normalized_goal(task["evaluation_criteria"])
                               if isinstance(task.get("evaluation_criteria"), dict) else None])):
            signal_key = signal, canonical(value)
            if signal_key in seen:
                parent[root(task_id)] = root(seen[signal_key])
            else:
                seen[signal_key] = task_id
    grouped: dict[str, list[str]] = {}
    for task_id in sorted(set(ids)):
        grouped.setdefault(root(task_id), []).append(task_id)
    return tuple(sorted(tuple(v) for v in grouped.values()))


def qualify(objects: CAS, task_bytes: bytes, split_bytes: bytes, *,
            assertion_allowlist: frozenset[tuple[str, str]],
            execute_checks: Callable[[dict[str, object]], None], seed: str = DEFAULT_SEED,
            mode: str = "adaptive") -> Qualification:
    if mode not in MODES:
        raise VerificationError("unknown qualification mode: " + mode)
    source = parse(task_bytes)
    if isinstance(source, dict):
        source = source.get("tasks")
    tasks = [obj(t) for t in items(source)]
    splits = {name: tuple(string(v) for v in items(ids)) for name, ids in obj(parse(split_bytes)).items()}
    failures: dict[str, tuple[str, ...]] = {}
    ids = [string(t.get("id")) for t in tasks]
    duplicates = tuple(sorted(task for task, count in Counter(ids).items() if count > 1))
    if duplicates:
        failures["duplicate inventory IDs"] = duplicates
    index = dict(zip(ids, tasks, strict=True))
    declared = {task for values in splits.values() for task in values}
    missing = declared - index.keys()
    if missing:
        failures["unresolved declared IDs"] = tuple(sorted(missing))
    for name, values in splits.items():
        if len(values) != len(set(values)):
            failures["duplicate split IDs: " + name] = tuple(sorted(v for v, n in Counter(values).items() if n > 1))
    base, train, test = (set(splits.get(k, ())) for k in ("base", "train", "test"))
    if not base or not train or not test or train & test or base != train | test:
        failures["base/train/test must be a disjoint union"] = tuple(sorted(base | train | test))
    selected = base if mode == "adaptive" else test
    histogram: Counter[str] = Counter()
    inventory_findings: dict[str, tuple[str, ...]] = {}
    checked = 0
    for task_id in sorted(index):
        task = index[task_id]
        try:
            criteria = obj(task.get("evaluation_criteria"))
            basis = tuple(string(v) for v in items(criteria.get("reward_basis")))
            histogram.update(basis)
            if not basis or set(basis) - DETERMINISTIC or criteria.get("nl_assertions"):
                raise VerificationError("required NL/unknown/missing reward basis or NL assertions")
            # Inspect every assertion, including diagnostic assertions.
            for assertion in items(criteria.get("env_assertions") or []):
                a = obj(assertion)
                if (string(a.get("env_type")), string(a.get("func_name"))) not in assertion_allowlist:
                    raise VerificationError("unqualified/nondeterministic assertion")
            if task_id in selected:
                execute_checks(task)  # Strict initialization, gold actions, all assertions.
                checked += 1
        except Exception as error:
            key = "task qualification: " + str(error)
            destination = failures if task_id in selected else inventory_findings
            destination[key] = (*destination.get(key, ()), task_id)
    grouped: dict[str, tuple[str, ...]] = {}
    try:
        grouped = group_tasks(tasks, seed)
    except VerificationError as error:
        failures[str(error)] = tuple(sorted(selected))
    groups = tuple(grouped.values())
    development: tuple[str, ...] = ()
    validation: tuple[str, ...] = ()
    audit: tuple[str, ...] = ()
    if not missing and groups and selected:
        if mode == "adaptive":
            try:
                development, validation, audit = whole_group_split(groups, selected)
                validate_partition(groups, selected, (development, validation, audit))
            except VerificationError as error:
                failures[str(error)] = tuple(sorted(selected))
        else:
            audit = splits["test"]  # Exact upstream order, no group gate or reallocation.
    actual = (len(development), len(validation), len(audit))
    # Legacy closure survives solely as an informational diagnostic, including
    # the original 2,285-ID finding. It cannot affect selected membership.
    try:
        legacy_diagnostic = crossing_report(legacy_connected_groups(tasks), train, test)
    except (TypeError, ValueError, VerificationError) as error:
        legacy_diagnostic = {"severity": "informational", "fatal": False, "error": str(error)}
    details: dict[str, object] = {
        "schema": "strive.telecom-qualification/2", "mode": mode,
        "split_origin": "strive-derived-base" if mode == "adaptive" else "tau2-stock-test",
        "leaderboard_comparability": "none" if mode == "adaptive" else "stock-test only; match model/settings/trials; upstream original leaderboard uses base",
        "grouping_algorithm": ALGORITHM, "seed": seed, "group_order": tuple(grouped),
        "group_to_ids": grouped, "groups": groups, "selected_ids": tuple(sorted(selected)),
        "development": development, "validation": validation, "audit": audit,
        "target_sizes": dict(zip(("development", "validation", "audit"), TARGET, strict=True)) if mode == "adaptive" else None,
        "actual_sizes": dict(zip(("development", "validation", "audit"), actual, strict=True)),
        "exact_target_achievable": actual == TARGET if mode == "adaptive" else None,
        "allocation_objective": OBJECTIVE if mode == "adaptive" else None,
        "checked_records": checked, "inventory_records": len(tasks), "reward_basis_histogram": dict(sorted(histogram.items())),
        "stock_split_cross_group": crossing_report(groups, train, test),
        "stock_split_legacy_cross_group": legacy_diagnostic,
        "unselected_grading_findings": {"severity": "informational", "failures": inventory_findings},
        "gates": {"deterministic_grading": "passed" if checked == len(selected) and selected else "blocked",
                  "adaptive_whole_group_disjoint": "not-applicable" if mode == "fixed-stock" else "passed" if not any(
                      sum(bool(set(group) & set(part)) for part in (development, validation, audit)) > 1 for group in groups
                  ) and set(development + validation + audit) == selected and selected else "blocked"},
        "assertion_allowlist": sorted(assertion_allowlist),
    }
    if failures:
        details.update(status="blocked", failures=failures)
        objects.publish(canonical(details))
        raise QualificationFailure(failures, details)
    details["status"] = "qualified"
    # Retain both source files which define the new grouping and qualification.
    implementation = objects.publish(encode(tuple((p.name, objects.publish(p.read_bytes())) for p in (
        Path(__file__), Path(__file__).with_name("splits.py")))))
    inventory, source_splits = objects.publish(task_bytes), objects.publish(split_bytes)
    detail_ref = objects.publish(canonical(details))
    report = objects.publish(encode(("qualified-telecom/2", implementation, inventory, source_splits,
        seed, groups, development, validation, audit, tuple(sorted(histogram.items())), len(tasks),
        tuple(sorted(assertion_allowlist)), mode, detail_ref)))
    return Qualification(inventory, source_splits, implementation, report, groups, development, validation, audit, mode, detail_ref)


def load_qualification(objects: CAS, report: ArtifactRef) -> Qualification:
    value = decode(objects.read(report))
    if not isinstance(value, tuple) or len(value) != 14 or value[0] != "qualified-telecom/2":
        raise VerificationError("remote adapter requires Amendment 3 qualification")
    implementation, inventory, splits = value[1:4]
    if not all(isinstance(ref, ArtifactRef) for ref in (implementation, inventory, splits, value[13])):
        raise VerificationError("invalid qualification references")
    assert isinstance(implementation, ArtifactRef) and isinstance(inventory, ArtifactRef) and isinstance(splits, ArtifactRef)
    groups, development, validation, audit = value[5:9]
    if (not isinstance(groups, tuple) or not all(isinstance(group, tuple) and all(isinstance(t, str) for t in group) for group in groups)
            or not all(isinstance(ids, tuple) and all(isinstance(t, str) for t in ids) for ids in (development, validation, audit))):
        raise VerificationError("invalid qualified memberships")
    assert isinstance(development, tuple) and isinstance(validation, tuple) and isinstance(audit, tuple)
    mode, details = value[12:14]
    if not isinstance(mode, str) or mode not in MODES or not isinstance(details, ArtifactRef):
        raise VerificationError("invalid qualification mode/details")
    metadata = obj(parse(objects.read(details)))
    if metadata.get("mode") != mode or metadata.get("status") != "qualified":
        raise VerificationError("qualification details disagree with certificate")
    if mode == "adaptive":
        validate_partition(groups, set(development + validation + audit), (development, validation, audit))
    return Qualification(inventory, splits, implementation, report, groups, development, validation, audit, mode, details)
