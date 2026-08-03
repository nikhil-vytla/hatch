from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from enum import StrEnum
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath

from parallax.checks import run_check
from parallax.models import CheckCategory, Recipe
from parallax.patching import EditError, apply_edits


class SnapshotError(ValueError):
    pass


@dataclass(frozen=True, order=True)
class SnapshotEntry:
    path: str
    kind: str
    content: bytes


@dataclass(frozen=True)
class TreeSnapshot:
    entries: tuple[SnapshotEntry, ...]
    ignored_paths: tuple[str, ...]

    @classmethod
    def capture(cls, root: Path, ignored_paths: Iterable[str] = ()) -> TreeSnapshot:
        ignored = tuple(ignored_paths)
        if not root.is_dir():
            raise SnapshotError(f"snapshot root is not a directory: {root}")
        entries: list[SnapshotEntry] = []

        def visit(directory: Path, relative_directory: PurePosixPath) -> None:
            try:
                children = sorted(os.scandir(directory), key=lambda item: item.name)
            except OSError as error:
                raise SnapshotError(f"cannot read candidate tree: {error}") from error
            for child in children:
                relative = relative_directory / child.name
                path = relative.as_posix()
                if _is_ignored(path, ignored):
                    continue
                try:
                    if child.is_symlink():
                        entries.append(
                            SnapshotEntry(path, "symlink", os.readlink(child.path).encode())
                        )
                    elif child.is_dir(follow_symlinks=False):
                        visit(Path(child.path), relative)
                    elif child.is_file(follow_symlinks=False):
                        entries.append(SnapshotEntry(path, "file", Path(child.path).read_bytes()))
                    else:
                        raise SnapshotError(f"unsupported candidate tree entry: {path}")
                except OSError as error:
                    raise SnapshotError(f"cannot capture candidate path {path}: {error}") from error

        visit(root, PurePosixPath())
        return cls(tuple(entries), ignored)

    def changed_paths(self, candidate: TreeSnapshot) -> tuple[str, ...]:
        baseline = {entry.path: entry for entry in self.entries}
        current = {entry.path: entry for entry in candidate.entries}
        return tuple(
            sorted(
                path
                for path in baseline.keys() | current.keys()
                if baseline.get(path) != current.get(path)
            )
        )


class GradeOutcome(StrEnum):
    SCORED = "scored"
    INVALID_SUBMISSION = "invalid_submission"
    ABSTAIN = "abstain"


@dataclass(frozen=True)
class ComponentScore:
    name: str
    category: CheckCategory
    value: float
    weight: float
    evidence: dict[str, object]


@dataclass(frozen=True)
class Grade:
    outcome: GradeOutcome
    reward: float
    integrity_gate: float
    components: tuple[ComponentScore, ...]
    changed_paths: tuple[str, ...]
    violations: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    def dump(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n")


def grade_candidate(
    recipe: Recipe,
    candidate_root: Path,
    baseline: TreeSnapshot,
) -> Grade:
    if baseline.ignored_paths != recipe.ignored_paths:
        raise ValueError("baseline ignored-path policy does not match recipe")
    with tempfile.TemporaryDirectory(prefix="parallax-baseline-check-") as temp:
        try:
            _prepare_evaluator(baseline, Path(temp) / "baseline", recipe)
        except (EditError, SnapshotError, OSError, UnicodeError) as error:
            raise RuntimeError(f"evaluator baseline cannot be prepared: {error}") from error

    try:
        candidate = TreeSnapshot.capture(candidate_root, recipe.ignored_paths)
    except SnapshotError as error:
        return _invalid(str(error))

    changed_paths = baseline.changed_paths(candidate)
    baseline_paths = {entry.path for entry in baseline.entries}
    candidate_paths = {entry.path for entry in candidate.entries}
    missing_paths = tuple(sorted(baseline_paths - candidate_paths))
    if missing_paths:
        return _invalid(
            "candidate removed baseline files: " + ", ".join(missing_paths),
            changed_paths=changed_paths,
        )

    allowed = set(recipe.allowed_paths)
    violations = tuple(
        f"forbidden path changed: {path}" for path in changed_paths if path not in allowed
    )
    integrity_gate = 0.0 if violations else 1.0

    with tempfile.TemporaryDirectory(prefix="parallax-grade-") as temp:
        evaluator_root = Path(temp) / "candidate"
        try:
            _prepare_evaluator(candidate, evaluator_root, recipe)
        except (EditError, SnapshotError, OSError, UnicodeError) as error:
            return _invalid(
                f"candidate cannot be prepared for evaluation: {error}",
                changed_paths=changed_paths,
                violations=violations,
            )
        components: list[ComponentScore] = []
        for check in recipe.checks:
            result = run_check(evaluator_root, check)
            if result.get("infrastructure_error"):
                return Grade(
                    outcome=GradeOutcome.ABSTAIN,
                    reward=0.0,
                    integrity_gate=integrity_gate,
                    components=tuple(components),
                    changed_paths=changed_paths,
                    violations=(*violations, str(result["stderr"])),
                )
            components.append(
                ComponentScore(
                    name=check.name,
                    category=check.category,
                    value=float(bool(result["passed"])),
                    weight=check.weight,
                    evidence=result,
                )
            )

    primary = tuple(
        component
        for component in components
        if component.category is CheckCategory.COUNTERFACTUAL
    )
    primary_weight = sum(component.weight for component in primary)
    primary_score = (
        sum(component.value * component.weight for component in primary) / primary_weight
    )
    hard_gate = float(
        all(
            component.value == 1.0
            for component in components
            if component.category in {CheckCategory.REGRESSION, CheckCategory.ADVERSARIAL}
        )
    )
    return Grade(
        outcome=GradeOutcome.SCORED,
        reward=integrity_gate * hard_gate * primary_score,
        integrity_gate=integrity_gate,
        components=tuple(components),
        changed_paths=changed_paths,
        violations=violations,
    )


def _invalid(
    reason: str,
    *,
    changed_paths: tuple[str, ...] = (),
    violations: tuple[str, ...] = (),
) -> Grade:
    return Grade(
        outcome=GradeOutcome.INVALID_SUBMISSION,
        reward=0.0,
        integrity_gate=0.0,
        components=(),
        changed_paths=changed_paths,
        violations=(*violations, reason),
    )


def _is_ignored(path: str, patterns: tuple[str, ...]) -> bool:
    if ".git" in PurePosixPath(path).parts:
        return True
    return any(
        fnmatch(path, pattern)
        or (pattern.startswith("**/") and fnmatch(path, pattern.removeprefix("**/")))
        for pattern in patterns
    )


def _materialize(snapshot: TreeSnapshot, destination: Path) -> None:
    destination.mkdir()
    for entry in snapshot.entries:
        target = destination / entry.path
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry.kind == "file":
            target.write_bytes(entry.content)
            continue
        link_target = entry.content.decode()
        if _symlink_escapes(entry.path, link_target):
            raise SnapshotError(f"symlink escapes candidate tree: {entry.path}")
        target.symlink_to(link_target)


def _prepare_evaluator(snapshot: TreeSnapshot, destination: Path, recipe: Recipe) -> None:
    _materialize(snapshot, destination)
    apply_edits(destination, recipe.probe_edits)


def _symlink_escapes(path: str, target: str) -> bool:
    if PurePosixPath(target).is_absolute():
        return True
    depth = len(PurePosixPath(path).parent.parts)
    for part in PurePosixPath(target).parts:
        if part == "..":
            depth -= 1
            if depth < 0:
                return True
        elif part not in {"", "."}:
            depth += 1
    return False
