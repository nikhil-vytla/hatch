"""Full-inventory hard gate. Failure never changes membership or reward criteria."""
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
import hashlib
from pathlib import Path

from strive.vnext.benchmarks.json_data import canonical, items, obj, parse, string
from strive.vnext.codec import encode
from strive.vnext.contracts.primitives import ArtifactRef
from strive.vnext.errors import VerificationError
from strive.vnext.store.cas import CAS

DETERMINISTIC = frozenset({"DB", "ENV_ASSERTION", "COMMUNICATE", "ACTION"})
DEFAULT_SEED = "strive-amendment-2-60-14-40-v1"


class QualificationFailure(VerificationError):
    def __init__(self, failures: dict[str, tuple[str, ...]]) -> None:
        self.failures = failures
        self.affected_ids = tuple(sorted({task for ids in failures.values() for task in ids}))
        self.proposed_campaign = (
            "Keep the 114-task reference campaign blocked. Review the listed tasks and connected groups; "
            "approve a separately named campaign with deterministic criteria and whole-group splits. "
            "Retain the original 60/14/40 denominator and audit IDs until that approval."
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


def normalized(value: object, *, persona: bool = False) -> object:
    if isinstance(value, dict):
        ignored = {"persona", "persona_config"} if persona else {"action_id", "message", "info"}
        return {str(k): normalized(v, persona=persona) for k, v in sorted(value.items()) if k not in ignored and v is not None}
    if isinstance(value, list):
        return [normalized(v, persona=persona) for v in value]
    if isinstance(value, str):
        return " ".join(value.split())
    return value


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


def qualify(objects: CAS, task_bytes: bytes, split_bytes: bytes, *,
            assertion_allowlist: frozenset[tuple[str, str]],
            execute_checks: Callable[[dict[str, object]], None], seed: str = DEFAULT_SEED) -> Qualification:
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
    base, train, audit = (set(splits.get(k, ())) for k in ("base", "train", "test"))
    if len(train) != 74 or len(audit) != 40 or train & audit or base != train | audit:
        failures["base/train/test must be disjoint 74/40 union"] = tuple(sorted(base | train | audit))
    histogram: Counter[str] = Counter()
    for task_id, task in zip(ids, tasks, strict=True):
        try:
            criteria = obj(task.get("evaluation_criteria"))
            basis = tuple(string(v) for v in items(criteria.get("reward_basis")))
            if not basis or set(basis) - DETERMINISTIC:
                raise VerificationError("required NL/unknown/missing reward basis")
            histogram.update(basis)
            # Inspect every assertion, even diagnostic assertions upstream may run.
            for assertion in items(criteria.get("env_assertions") or []):
                a = obj(assertion)
                if (string(a.get("env_type")), string(a.get("func_name"))) not in assertion_allowlist:
                    raise VerificationError("unqualified/nondeterministic assertion")
            execute_checks(task)  # Strict initialization, gold actions and assertion execution.
        except Exception as error:
            key = "task qualification: " + str(error)
            failures[key] = (*failures.get(key, ()), task_id)
    # Either equivalence signal connects scenarios. Transitive closure matters.
    parent = {task_id: task_id for task_id in ids}
    def root(task_id: str) -> str:
        while parent[task_id] != task_id:
            task_id = parent[task_id]
        return task_id
    seen: dict[tuple[str, bytes], str] = {}
    for task_id, task in zip(ids, tasks, strict=True):
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
    groups = tuple(sorted((tuple(v) for v in grouped.values()), key=lambda group: (
        hashlib.sha256(canonical([seed, group])).hexdigest(), group)))
    crossing = tuple(task for group in groups if set(group) & train and set(group) & audit for task in group)
    if crossing:
        failures["connected scenario group crosses train/audit"] = crossing
    training_groups = tuple(tuple(t for t in group if t in train) for group in groups if set(group) & train)
    possibilities: dict[int, tuple[int, ...]] = {0: ()}
    for position, group in enumerate(training_groups):
        for count, chosen in list(possibilities.items()):
            total = count + len(group)
            if total <= 14 and total not in possibilities:
                possibilities[total] = (*chosen, position)
    if 14 not in possibilities:
        failures["whole-group 60/14 partition impossible"] = tuple(sorted(train))
    if failures:
        # Protected preparation output only; never a candidate-facing projection.
        failure_report = {"status": "blocked", "failures": failures, "seed": seed, "groups": groups, "assertion_allowlist": sorted(assertion_allowlist)}
        objects.publish(canonical(failure_report))
        raise QualificationFailure(failures)
    validation = tuple(t for p in possibilities[14] for t in training_groups[p])
    development = tuple(t for group in training_groups for t in group if t not in validation)
    audit_order = tuple(t for group in groups for t in group if t in audit)
    implementation = objects.publish(Path(__file__).read_bytes())
    inventory, source_splits = objects.publish(task_bytes), objects.publish(split_bytes)
    report = objects.publish(encode(("qualified-telecom/1", implementation, inventory, source_splits,
        seed, groups, development, validation, audit_order, tuple(sorted(histogram.items())), len(tasks), tuple(sorted(assertion_allowlist)))))
    return Qualification(inventory, source_splits, implementation, report, groups, development, validation, audit_order)
