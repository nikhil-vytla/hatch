from __future__ import annotations

import hashlib
import re
from pathlib import Path, PurePosixPath
from typing import Literal, Self

from pydantic import field_validator, model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .specs import EnvSpecV1, PublicTaskV1, SealedAuthorityV1, TaskSpecV1
from .types import DigestText, StrictModel

HUD_VERSION = "0.6.12"
COMPILER_VERSION = "hud-v1"
Audience = Literal["agent", "evaluator"]


class SealedLeakError(ValueError):
    pass


def _artifact_digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


class CompiledArtifactV1(StrictModel):
    path: str
    audience: Audience
    content: bytes

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or value in {"", "."}:
            raise ValueError("compiled artifact path must be relative")
        return value


class ArtifactDigestV1(StrictModel):
    path: str
    audience: Audience
    digest: DigestText


class CompileReceiptV1(StrictModel):
    compiler_version: Literal["hud-v1"] = COMPILER_VERSION
    public_digest: DigestText
    spec_digest: DigestText
    environment_digest: DigestText
    artifacts: tuple[ArtifactDigestV1, ...]


class CompiledEvaluatorV1(StrictModel):
    schema_version: Literal[1] = 1
    task: TaskSpecV1
    environment: EnvSpecV1


class CompiledBundleV1(StrictModel):
    target: Literal["hud"] = "hud"
    artifacts: tuple[CompiledArtifactV1, ...]
    receipt: CompileReceiptV1

    @model_validator(mode="after")
    def receipt_matches_artifacts(self) -> Self:
        expected = tuple(
            ArtifactDigestV1(
                path=artifact.path,
                audience=artifact.audience,
                digest=_artifact_digest(artifact.content),
            )
            for artifact in self.artifacts
        )
        if self.receipt.artifacts != expected:
            raise ValueError("compiled artifact receipt drift")
        return self

    @property
    def agent_artifacts(self) -> tuple[CompiledArtifactV1, ...]:
        return tuple(
            artifact for artifact in self.artifacts if artifact.audience == "agent"
        )

    @property
    def evaluator_artifacts(self) -> tuple[CompiledArtifactV1, ...]:
        return tuple(
            artifact for artifact in self.artifacts if artifact.audience == "evaluator"
        )

    def write_agent_context(self, directory: Path) -> None:
        for artifact in self.agent_artifacts:
            atomic_write(directory / artifact.path, artifact.content)


def sealed_fragments(
    sealed: SealedAuthorityV1,
    *,
    public: PublicTaskV1 | None = None,
) -> tuple[bytes, ...]:
    mandatory = {sealed.test_patch.encode()}
    derived = {
        value.encode()
        for value in (*sealed.fail_to_pass, *sealed.pass_to_pass)
        if value
    }
    for line in sealed.test_patch.splitlines():
        if line.startswith("@@") and len(line) >= 4:
            derived.add(line.encode())
        if (
            line.startswith("+")
            and not line.startswith("+++")
            and len(line[1:].strip()) >= 4
        ):
            derived.add(line[1:].strip().encode())
        match = re.match(r"^\+\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)", line)
        if match:
            derived.add(match.group(1).encode())
    if public is not None:
        public_bytes = canonical_bytes(public)
        derived = {fragment for fragment in derived if fragment not in public_bytes}
    return tuple(sorted(mandatory | derived))


def assert_agent_artifacts_clean(
    sealed: SealedAuthorityV1,
    artifacts: tuple[CompiledArtifactV1, ...],
    *,
    public: PublicTaskV1 | None = None,
) -> None:
    fragments = sealed_fragments(sealed, public=public)
    for artifact in artifacts:
        if artifact.audience != "agent":
            continue
        surface = artifact.path.encode() + b"\0" + artifact.content
        if any(fragment in surface for fragment in fragments):
            raise SealedLeakError(
                f"agent artifact contains sealed verifier fragment: {artifact.path}"
            )


def _compile_agent_artifacts(
    public: PublicTaskV1,
    environment: EnvSpecV1,
) -> tuple[CompiledArtifactV1, ...]:
    instance = {
        "environment_name": f"parallax-{public.source.instance_id}",
        "source": {
            **public.source.model_dump(mode="json"),
            "public_digest": canonical_digest(public),
        },
        "scripts": {
            script.arm: {
                "agent_steps": script.agent_steps,
                "max_output_tokens": script.max_output_tokens,
                "turns": script.turns,
            }
            for script in public.scripts
        },
        "version": "1.0.0",
    }
    dockerfile = (
        "FROM --platform=linux/amd64 "
        f"{environment.image.ref}@sha256:{environment.image.digest}\n\n"
        "RUN python -m venv /opt/hud-venv && "
        "/opt/hud-venv/bin/python -m pip install --no-cache-dir "
        f'"hud=={HUD_VERSION}" && '
        "(command -v bwrap >/dev/null || "
        "(apt-get update && apt-get install -y --no-install-recommends "
        "bubblewrap util-linux && rm -rf /var/lib/apt/lists/*))\n\n"
        f"RUN chown -R {environment.workspace.shell_uid}:"
        f"{environment.workspace.shell_uid} {environment.workspace.root}\n\n"
        "WORKDIR /app\n"
        "COPY env.py instance.json swebench_runtime.py /app/\n\n"
        "EXPOSE 8765\n"
        'CMD ["/opt/hud-venv/bin/hud", "serve", "env.py", '
        '"--host", "0.0.0.0", "--port", "8765"]\n'
    ).encode()
    runtime_path = Path(__file__).with_name("swebench_runtime.py")
    return (
        CompiledArtifactV1(
            path="instance.json",
            audience="agent",
            content=canonical_bytes(instance) + b"\n",
        ),
        CompiledArtifactV1(
            path="env.py",
            audience="agent",
            content=b"from swebench_runtime import env\n",
        ),
        CompiledArtifactV1(
            path="swebench_runtime.py",
            audience="agent",
            content=runtime_path.read_bytes(),
        ),
        CompiledArtifactV1(
            path="Dockerfile.hud",
            audience="agent",
            content=dockerfile,
        ),
    )


def _compile_evaluator_artifacts(
    task: TaskSpecV1,
    environment: EnvSpecV1,
) -> tuple[CompiledArtifactV1, ...]:
    payload = CompiledEvaluatorV1(task=task, environment=environment)
    return (
        CompiledArtifactV1(
            path="evaluator.json",
            audience="evaluator",
            content=canonical_bytes(payload) + b"\n",
        ),
    )


def load_evaluator_specs(bundle: CompiledBundleV1) -> tuple[TaskSpecV1, EnvSpecV1]:
    if len(bundle.evaluator_artifacts) != 1:
        raise ValueError("compiled HUD bundle must contain one evaluator artifact")
    artifact = bundle.evaluator_artifacts[0]
    if artifact.path != "evaluator.json":
        raise ValueError("compiled HUD evaluator artifact has an unknown path")
    compiled = CompiledEvaluatorV1.model_validate_json(artifact.content)
    return compiled.task, compiled.environment


def compile_hud(task: TaskSpecV1, environment: EnvSpecV1) -> CompiledBundleV1:
    if environment.workspace.reset_to != task.public.source.base_commit:
        raise ValueError("workspace reset commit differs from public task")
    budgets = {
        (script.total_agent_steps, script.max_output_tokens)
        for script in task.public.scripts
    }
    expected_budget = (
        environment.budget.total_agent_steps,
        environment.budget.max_output_tokens,
    )
    if budgets != {expected_budget}:
        raise ValueError("environment budget differs from public task")
    agent_artifacts = _compile_agent_artifacts(task.public, environment)
    assert_agent_artifacts_clean(
        task.sealed,
        agent_artifacts,
        public=task.public,
    )
    artifacts = (
        *agent_artifacts,
        *_compile_evaluator_artifacts(task, environment),
    )
    receipt = CompileReceiptV1(
        public_digest=task.public_digest,
        spec_digest=task.spec_digest,
        environment_digest=environment.digest,
        artifacts=tuple(
            ArtifactDigestV1(
                path=artifact.path,
                audience=artifact.audience,
                digest=_artifact_digest(artifact.content),
            )
            for artifact in artifacts
        ),
    )
    return CompiledBundleV1(artifacts=artifacts, receipt=receipt)
