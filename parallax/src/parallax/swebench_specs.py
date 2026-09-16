"""Freeze a SWE-bench task into specs, then compile the agent's environment.

Two things happen here and they are deliberately in one module, because the
sealed/public split is the only reason either exists: `freeze_swe_task` decides
what is public and what is sealed, and `compile_bundle` builds the agent's build
context from the public half and then proves no sealed byte reached it.

Identity is scoped to the task, not to the experimental design. `SweTaskSpec`
covers the issue and the sealed authority; the conditions an experiment happens
to run are compiled into the bundle but are not part of the spec digest. The
previous model hashed every arm's turn text into the spec, so retiring an arm
nobody ran changed the identity of tasks whose own material was untouched and
invalidated their committed admission records.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path, PurePosixPath
from typing import Literal, Self

from pydantic import Field, field_validator, model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .perturbation import VariantSet
from .swebench import CommitSha, ImageDigest, InstanceId, SweBenchTask
from .types import DigestText, NonEmptyText, PositiveInt, StrictModel

HUD_VERSION = "0.6.12"
COMPILER_VERSION = "hud-v1"
Audience = Literal["agent", "evaluator"]


class SealedLeakError(ValueError):
    pass


class SwePublicSource(StrictModel):
    record_id: NonEmptyText
    instance_id: InstanceId
    repo: NonEmptyText
    base_commit: CommitSha
    problem_statement: NonEmptyText
    version: NonEmptyText
    difficulty: str
    dataset: NonEmptyText
    dataset_revision: CommitSha


class SweSealedAuthority(StrictModel):
    harness_revision: CommitSha
    gold_patch: NonEmptyText
    test_patch: NonEmptyText
    fail_to_pass: tuple[NonEmptyText, ...] = Field(min_length=1)
    pass_to_pass: tuple[NonEmptyText, ...]


class SweTaskSpec(StrictModel):
    schema_version: Literal[1] = 1
    public: SwePublicSource
    sealed: SweSealedAuthority

    @property
    def public_digest(self) -> DigestText:
        return canonical_digest(self.public)

    @property
    def spec_digest(self) -> DigestText:
        return canonical_digest(self)


class ImageIdentity(StrictModel):
    ref: NonEmptyText
    digest: ImageDigest


class WorkspacePolicy(StrictModel):
    """Container facts the compiled Dockerfile depends on.

    `network` and `shell_uid` are pinned rather than configurable because an
    agent with a network, or one running as root in the testbed, would defeat
    both the sealed split and the patch export. Making those unrepresentable is
    cheaper than a gate that checks them.
    """

    root: NonEmptyText = "/testbed"
    network: Literal[False] = False
    shell_uid: Literal[1000] = 1000
    reset_to: CommitSha


class ToolDecl(StrictModel):
    name: NonEmptyText
    protocol: Literal["ssh/2", "mcp"]


class SweEnvSpec(StrictModel):
    schema_version: Literal[1] = 1
    image: ImageIdentity
    workspace: WorkspacePolicy
    tools: tuple[ToolDecl, ...] = Field(min_length=1)
    verifier_timeout_seconds: PositiveInt = 1800

    @property
    def digest(self) -> DigestText:
        return canonical_digest(self)


def freeze_swe_task(task: SweBenchTask) -> tuple[SweTaskSpec, SweEnvSpec]:
    verifier = task.verifier
    spec = SweTaskSpec(
        public=SwePublicSource(
            record_id=task.record_id,
            instance_id=task.instance_id,
            repo=task.repo,
            base_commit=task.base_commit,
            problem_statement=task.problem_statement,
            version=task.version,
            difficulty=task.difficulty,
            dataset=task.dataset,
            dataset_revision=task.dataset_revision,
        ),
        sealed=SweSealedAuthority(
            harness_revision=verifier.harness_revision,
            gold_patch=verifier.gold_patch,
            test_patch=verifier.test_patch,
            fail_to_pass=verifier.fail_to_pass,
            pass_to_pass=verifier.pass_to_pass,
        ),
    )
    environment = SweEnvSpec(
        image=ImageIdentity(ref=verifier.image_ref, digest=verifier.image_digest),
        workspace=WorkspacePolicy(reset_to=task.base_commit),
        tools=(ToolDecl(name="shell", protocol="ssh/2"),),
    )
    return spec, environment


def _artifact_digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


class CompiledArtifact(StrictModel):
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


class ArtifactDigest(StrictModel):
    path: str
    audience: Audience
    digest: DigestText


class SealedLeakMatch(StrictModel):
    artifact_path: str
    fragment_digest: DigestText
    fragment_length: int


class CompileReceipt(StrictModel):
    compiler_version: Literal["hud-v1"] = COMPILER_VERSION
    public_digest: DigestText
    spec_digest: DigestText
    environment_digest: DigestText
    condition_digests: tuple[tuple[str, DigestText], ...]
    artifacts: tuple[ArtifactDigest, ...]


class CompiledEvaluator(StrictModel):
    schema_version: Literal[1] = 1
    task: SweTaskSpec
    environment: SweEnvSpec


class CompiledBundle(StrictModel):
    target: Literal["hud"] = "hud"
    artifacts: tuple[CompiledArtifact, ...]
    receipt: CompileReceipt

    @model_validator(mode="after")
    def receipt_matches_artifacts(self) -> Self:
        expected = tuple(
            ArtifactDigest(
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
    def agent_artifacts(self) -> tuple[CompiledArtifact, ...]:
        return tuple(
            artifact for artifact in self.artifacts if artifact.audience == "agent"
        )

    @property
    def evaluator_artifacts(self) -> tuple[CompiledArtifact, ...]:
        return tuple(
            artifact for artifact in self.artifacts if artifact.audience == "evaluator"
        )

    def write_agent_context(self, directory: Path) -> None:
        for artifact in self.agent_artifacts:
            atomic_write(directory / artifact.path, artifact.content)


def sealed_fragments(
    sealed: SweSealedAuthority,
    *,
    public: object | None = None,
) -> tuple[bytes, ...]:
    mandatory = {sealed.gold_patch.encode(), sealed.test_patch.encode()}
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


def find_sealed_leak(
    sealed: SweSealedAuthority,
    artifacts: tuple[CompiledArtifact, ...],
    *,
    public: object | None = None,
) -> SealedLeakMatch | None:
    fragments = sealed_fragments(sealed, public=public)
    for artifact in artifacts:
        if artifact.audience != "agent":
            continue
        surface = artifact.path.encode() + b"\0" + artifact.content
        for fragment in fragments:
            if fragment in surface:
                return SealedLeakMatch(
                    artifact_path=artifact.path,
                    fragment_digest=_artifact_digest(fragment),
                    fragment_length=len(fragment),
                )
    return None


def assert_agent_artifacts_clean(
    sealed: SweSealedAuthority,
    artifacts: tuple[CompiledArtifact, ...],
    *,
    public: object | None = None,
) -> None:
    match = find_sealed_leak(sealed, artifacts, public=public)
    if match is not None:
        raise SealedLeakError(
            f"agent artifact contains sealed verifier fragment: {match.artifact_path}"
        )


# The agent image ships a miniature `parallax` package. These modules must be
# importable from an empty `parallax/__init__.py` with no other package
# contents, which is why `types.py` travels with them: `delivery.py` imports
# its base types from it rather than redeclaring them.
_SHIPPED_MODULES = ("types.py", "delivery.py", "swebench_runtime.py")


def _dockerfile(environment: SweEnvSpec) -> bytes:
    return (
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
        "COPY env.py instance.json /app/\n"
        "COPY parallax /app/parallax\n\n"
        "EXPOSE 8765\n"
        'CMD ["/opt/hud-venv/bin/hud", "serve", "env.py", '
        '"--host", "0.0.0.0", "--port", "8765"]\n'
    ).encode()


def _agent_artifacts(
    spec: SweTaskSpec,
    environment: SweEnvSpec,
    variants: VariantSet,
) -> tuple[CompiledArtifact, ...]:
    instance = {
        "environment_name": f"parallax-{spec.public.instance_id}",
        "source": {
            **spec.public.model_dump(mode="json"),
            "public_digest": spec.public_digest,
        },
        "conditions": {
            str(variant.condition): {
                "steps": [turn.steps for turn in variant.turns],
                "per_step_output_tokens": [
                    turn.per_step_output for turn in variant.turns
                ],
                "turns": list(variants.prompts(variant.condition)),
            }
            for variant in variants.variants
        },
        "version": "1.0.0",
    }
    here = Path(__file__).parent
    return (
        CompiledArtifact(
            path="instance.json",
            audience="agent",
            content=canonical_bytes(instance) + b"\n",
        ),
        CompiledArtifact(
            path="env.py",
            audience="agent",
            content=b"from parallax.swebench_runtime import env\n",
        ),
        CompiledArtifact(path="parallax/__init__.py", audience="agent", content=b""),
        *(
            CompiledArtifact(
                path=f"parallax/{name}",
                audience="agent",
                content=(here / name).read_bytes(),
            )
            for name in _SHIPPED_MODULES
        ),
        CompiledArtifact(
            path="Dockerfile.hud",
            audience="agent",
            content=_dockerfile(environment),
        ),
    )


def load_evaluator_specs(bundle: CompiledBundle) -> tuple[SweTaskSpec, SweEnvSpec]:
    if len(bundle.evaluator_artifacts) != 1:
        raise ValueError("compiled HUD bundle must contain one evaluator artifact")
    artifact = bundle.evaluator_artifacts[0]
    if artifact.path != "evaluator.json":
        raise ValueError("compiled HUD evaluator artifact has an unknown path")
    compiled = CompiledEvaluator.model_validate_json(artifact.content)
    return compiled.task, compiled.environment


def compile_bundle(
    spec: SweTaskSpec,
    environment: SweEnvSpec,
    variants: VariantSet,
) -> CompiledBundle:
    if environment.workspace.reset_to != spec.public.base_commit:
        raise ValueError("workspace reset commit differs from the public task")
    if not variants.variants:
        raise ValueError("compiling an environment requires at least one condition")
    agent_artifacts = _agent_artifacts(spec, environment, variants)
    assert_agent_artifacts_clean(spec.sealed, agent_artifacts, public=spec.public)
    artifacts = (
        *agent_artifacts,
        CompiledArtifact(
            path="evaluator.json",
            audience="evaluator",
            content=canonical_bytes(
                CompiledEvaluator(task=spec, environment=environment)
            )
            + b"\n",
        ),
    )
    return CompiledBundle(
        artifacts=artifacts,
        receipt=CompileReceipt(
            public_digest=spec.public_digest,
            spec_digest=spec.spec_digest,
            environment_digest=environment.digest,
            condition_digests=tuple(
                (str(variant.condition), variant.digest)
                for variant in variants.variants
            ),
            artifacts=tuple(
                ArtifactDigest(
                    path=artifact.path,
                    audience=artifact.audience,
                    digest=_artifact_digest(artifact.content),
                )
                for artifact in artifacts
            ),
        ),
    )
