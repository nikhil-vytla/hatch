from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from parallax.compiler import run_check
from parallax.models import Recipe
from parallax.patching import apply_edits


@dataclass(frozen=True)
class ComponentScore:
    name: str
    category: str
    value: float
    weight: float
    evidence: dict[str, object]


@dataclass(frozen=True)
class Grade:
    reward: float
    integrity_gate: float
    components: tuple[ComponentScore, ...]
    changed_paths: tuple[str, ...]
    violations: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    def dump(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n")


def grade_candidate(recipe: Recipe, candidate_root: Path) -> Grade:
    changed_paths = _changed_paths(candidate_root)
    allowed = set(recipe.allowed_paths)
    violations = tuple(
        f"forbidden path changed: {path}" for path in changed_paths if path not in allowed
    )
    integrity_gate = 0.0 if violations else 1.0

    with tempfile.TemporaryDirectory(prefix="parallax-grade-") as temp:
        evaluator_root = Path(temp) / "candidate"
        shutil.copytree(
            candidate_root,
            evaluator_root,
            ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", ".pytest_cache"),
        )
        apply_edits(evaluator_root, recipe.probe_edits)
        components: list[ComponentScore] = []
        for check in recipe.checks:
            result = run_check(evaluator_root, check)
            components.append(
                ComponentScore(
                    name=check.name,
                    category=check.category,
                    value=float(bool(result["passed"])),
                    weight=check.weight,
                    evidence=result,
                )
            )

    positive_weight = sum(component.weight for component in components)
    if positive_weight <= 0:
        raise ValueError("recipe checks must have positive total weight")
    outcome = sum(
        component.value * component.weight for component in components
    ) / positive_weight
    contract_gate = float(
        all(
            component.value == 1.0
            for component in components
            if component.category == "counterfactual"
        )
    )
    return Grade(
        reward=integrity_gate * contract_gate * outcome,
        integrity_gate=integrity_gate,
        components=tuple(components),
        changed_paths=changed_paths,
        violations=violations,
    )


def _changed_paths(root: Path) -> tuple[str, ...]:
    if not (root / ".git").exists():
        raise ValueError("candidate workspace must contain an evaluator-created git repository")
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=root,
        capture_output=True,
        check=True,
    )
    entries = completed.stdout.decode().split("\0")
    paths: list[str] = []
    for entry in entries:
        if not entry:
            continue
        path = entry[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path)
    return tuple(sorted(set(paths)))
