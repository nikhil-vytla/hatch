"""Amendment 3: direct base-template groups and deterministic whole-group allocation."""
import hashlib
import re

from strive.benchmarks.json_data import canonical, obj, string
from strive.errors import VerificationError

ALGORITHM = "tau2-base-template/1"
DEFAULT_SEED = "strive-amendment-3-60-14-40-v1"
TARGET = (60, 14, 40)
OBJECTIVE = "nonempty dev/val/audit when at least three groups; min(sum absolute size errors, max error, audit error, validation error, development error, dev size, val size); first seeded DP path breaks assignment ties"


def normalized(value: object, *, persona: bool = False) -> object:
    if isinstance(value, dict):
        ignored = {"persona", "persona_config"} if persona else {"action_id", "message", "info"}
        return {str(k): normalized(v, persona=persona) for k, v in sorted(value.items()) if k not in ignored and v is not None}
    if isinstance(value, list):
        return [normalized(v, persona=persona) for v in value]
    if isinstance(value, str):
        return " ".join(value.split())
    return value


def scenario_group(task: dict[str, object]) -> str:
    """TaskManager's [name] template precedes composed conditions and PERSONA.

    The condition list is alphabetically composed, not an ancestry path. Neither
    its first token nor shared goals establish a distinct base scenario seed.
    Non-generator contract fixtures use exact persona-free scenario equality.
    """
    task_id = string(task.get("id"))
    if task_id.startswith("["):
        match = re.fullmatch(r"\[([a-z][a-z0-9_]*)\](?:[a-z0-9_]+(?:\|[a-z0-9_]+)*)?(?:\[PERSONA:[^\[\]]+\])?", task_id)
        if match is None:
            raise VerificationError("unrecognized generated scenario ID: " + task_id)
        return "[" + match[1] + "]"
    scenario = obj(task.get("user_scenario"))
    if not scenario.get("instructions"):
        raise VerificationError("missing base scenario: " + task_id)
    return "scenario:" + hashlib.sha256(canonical(normalized(scenario, persona=True))).hexdigest()


def group_tasks(tasks: list[dict[str, object]], seed: str = DEFAULT_SEED) -> dict[str, tuple[str, ...]]:
    groups: dict[str, list[str]] = {}
    for task in tasks:
        groups.setdefault(scenario_group(task), []).append(string(task["id"]))
    # Group ordering depends only on seed + root, never inventory traversal or
    # out-of-pool variants. IDs within each group have lexical order.
    return {key: tuple(sorted(groups[key])) for key in sorted(groups, key=lambda key: (
        hashlib.sha256(canonical([seed, key])).hexdigest(), key))}


def size_error(sizes: tuple[int, int, int], target: tuple[int, int, int] = TARGET) -> tuple[int, ...]:
    dev, val, audit = (abs(a - b) for a, b in zip(sizes, target, strict=True))
    return sum((dev, val, audit)), max(dev, val, audit), audit, val, dev


def whole_group_split(groups: tuple[tuple[str, ...], ...], selected: set[str], *,
                      target: tuple[int, int, int] = TARGET) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    """Exhaustive reachable-size DP, with no task dropping or group subdivision.

    A group means its entire intersection with the preselected pool. Tasks outside
    that pool never enter any arm. Keep the first assignment to each size pair;
    sorted DP traversal and dev/val/audit transition order make ties reproducible.
    """
    pool = tuple(tuple(t for t in group if t in selected) for group in groups)
    pool = tuple(group for group in pool if group)
    flattened = [t for group in pool for t in group]
    if len(flattened) != len(set(flattened)) or set(flattened) != selected or not selected:
        raise VerificationError("group mapping must cover each selected task exactly once")
    states: dict[tuple[int, int], tuple[int, ...]] = {(0, 0): ()}
    for group in pool:
        updated: dict[tuple[int, int], tuple[int, ...]] = {}
        for (dev, val), path in sorted(states.items()):
            for arm, counts in enumerate(((dev + len(group), val), (dev, val + len(group)), (dev, val))):
                updated.setdefault(counts, (*path, arm))
        states = updated
    eligible = [p for p in states if len(pool) < 3 or min(p[0], p[1], len(selected) - sum(p)) > 0]
    counts = min(eligible, key=lambda p: (size_error((p[0], p[1], len(selected) - sum(p)), target), p))
    assignments = states[counts]
    result = tuple(tuple(t for group, arm in zip(pool, assignments, strict=True) if arm == wanted for t in group)
                   for wanted in range(3))
    return result[0], result[1], result[2]


def validate_partition(groups: tuple[tuple[str, ...], ...], selected: set[str],
                       parts: tuple[tuple[str, ...], ...]) -> None:
    flat = [t for part in parts for t in part]
    if len(flat) != len(set(flat)) or set(flat) != selected:
        raise VerificationError("adaptive split omits or repeats selected tasks")
    if any(sum(bool(set(group) & set(part)) for part in parts) > 1 for group in groups):
        raise VerificationError("adaptive base scenario group crosses partitions")


def crossing_report(groups: tuple[tuple[str, ...], ...], train: set[str], test: set[str]) -> dict[str, object]:
    crossing = tuple(group for group in groups if set(group) & train and set(group) & test)
    ids = tuple(sorted(t for group in crossing for t in group))
    return {"severity": "informational", "fatal": False, "group_count": len(crossing),
            "inventory_id_count": len(ids), "stock_train_id_count": len(set(ids) & train),
            "stock_test_id_count": len(set(ids) & test), "ids": ids}
