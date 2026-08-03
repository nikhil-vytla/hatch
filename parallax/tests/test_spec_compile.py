from __future__ import annotations

import json
from pathlib import Path
from typing import get_type_hints

import pytest
from test_swebench_env import family

from parallax.hud_compile import (
    SealedLeakError,
    _compile_agent_artifacts,
    compile_hud,
)
from parallax.specs import PublicTaskV1, freeze_swe_specs


def test_compile_hud_is_deterministic_and_audience_tagged(tmp_path: Path) -> None:
    task, environment = freeze_swe_specs(family())

    first = compile_hud(task, environment)
    second = compile_hud(task, environment)

    assert first == second
    assert get_type_hints(_compile_agent_artifacts)["public"] is PublicTaskV1
    assert {artifact.audience for artifact in first.artifacts} == {
        "agent",
        "evaluator",
    }
    assert {artifact.path for artifact in first.agent_artifacts} == {
        "Dockerfile.hud",
        "env.py",
        "instance.json",
        "parallax/__init__.py",
        "parallax/delivery.py",
        "parallax/swebench_runtime.py",
    }
    evaluator = json.loads(first.evaluator_artifacts[0].content)
    assert evaluator["task"]["sealed"]["test_patch"] == task.sealed.test_patch
    first.write_agent_context(tmp_path)
    assert {
        path.relative_to(tmp_path).as_posix()
        for path in tmp_path.rglob("*")
        if path.is_file()
    } == {
        "Dockerfile.hud",
        "env.py",
        "instance.json",
        "parallax/__init__.py",
        "parallax/delivery.py",
        "parallax/swebench_runtime.py",
    }


def test_agent_compiler_byte_scan_rejects_sealed_fragment() -> None:
    task, environment = freeze_swe_specs(family())
    leaked_public = task.public.model_copy(
        update={
            "source": task.public.source.model_copy(
                update={"problem_statement": task.sealed.test_patch}
            )
        }
    )

    with pytest.raises(SealedLeakError, match="agent artifact"):
        compile_hud(task.model_copy(update={"public": leaked_public}), environment)


def test_agent_compiler_allows_derived_fragment_already_public() -> None:
    task, environment = freeze_swe_specs(family())
    overlapping_public = task.public.model_copy(
        update={
            "source": task.public.source.model_copy(
                update={"problem_statement": task.sealed.fail_to_pass[0]}
            )
        }
    )

    bundle = compile_hud(
        task.model_copy(update={"public": overlapping_public}),
        environment,
    )

    assert task.sealed.fail_to_pass[0].encode() in bundle.agent_artifacts[0].content


def test_compiler_receipt_binds_specs_and_every_artifact() -> None:
    task, environment = freeze_swe_specs(family())
    bundle = compile_hud(task, environment)

    assert bundle.receipt.public_digest == task.public_digest
    assert bundle.receipt.spec_digest == task.spec_digest
    assert bundle.receipt.environment_digest == environment.digest
    assert {(item.path, item.audience) for item in bundle.receipt.artifacts} == {
        (artifact.path, artifact.audience) for artifact in bundle.artifacts
    }
