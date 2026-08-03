from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from parallax.ids import digest_value, task_id_for


class SweBenchIntentArm(StrEnum):
    STATIC = "static"
    MATCHED = "matched"
    EVOLVED = "evolved"


@dataclass(frozen=True)
class SweBenchSource:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    dataset: str
    dataset_revision: str

    def public_capsule(self) -> dict[str, Any]:
        return {
            "base_commit": self.base_commit,
            "dataset": self.dataset,
            "dataset_revision": self.dataset_revision,
            "instance_id": self.instance_id,
            "problem_statement": self.problem_statement,
            "repo": self.repo,
        }

    @property
    def digest(self) -> str:
        return digest_value(self.public_capsule())


@dataclass(frozen=True)
class SweBenchVerifier:
    harness_revision: str
    test_patch: str
    fail_to_pass: tuple[str, ...]
    pass_to_pass: tuple[str, ...]

    def sealed_capsule(self) -> dict[str, Any]:
        return {
            "fail_to_pass": self.fail_to_pass,
            "harness_revision": self.harness_revision,
            "pass_to_pass": self.pass_to_pass,
            "test_patch": self.test_patch,
        }

    @property
    def digest(self) -> str:
        return digest_value(self.sealed_capsule())


@dataclass(frozen=True)
class SweBenchEpisode:
    source: SweBenchSource
    verifier: SweBenchVerifier
    arm: SweBenchIntentArm
    turns: tuple[str, ...]
    generator_version: str = "swebench-evolving-intent-v1"

    @property
    def public_digest(self) -> str:
        return digest_value(
            {
                "arm": self.arm,
                "generator_version": self.generator_version,
                "opening_turn": self.turns[0],
                "source_digest": self.source.digest,
            }
        )

    @property
    def sealed_digest(self) -> str:
        return digest_value(
            {
                "scheduled_turns": self.turns[1:],
                "verifier_digest": self.verifier.digest,
            }
        )

    @property
    def task_id(self) -> str:
        return task_id_for(self.public_digest, self.sealed_digest)


def compile_swebench_arms(
    source: SweBenchSource,
    verifier: SweBenchVerifier,
    *,
    orientation: str,
    plan: str,
) -> tuple[SweBenchEpisode, ...]:
    problem = source.problem_statement.strip()
    if not problem or not orientation.strip() or not plan.strip():
        raise ValueError("source problem, orientation, and plan must be non-empty")

    schedules = {
        SweBenchIntentArm.STATIC: (problem,),
        SweBenchIntentArm.MATCHED: (
            f"{problem}\n\nFirst inspect the repository and identify the smallest "
            "relevant surface.",
            "No requirements have changed. Propose the smallest implementation "
            "and focused test plan.",
            "Implement the unchanged task now and run the focused tests.",
        ),
        SweBenchIntentArm.EVOLVED: (
            orientation.strip(),
            plan.strip(),
            f"{problem}\n\nImplement the fix now and run the focused tests.",
        ),
    }
    return tuple(
        SweBenchEpisode(
            source=source,
            verifier=verifier,
            arm=arm,
            turns=schedules[arm],
        )
        for arm in SweBenchIntentArm
    )
