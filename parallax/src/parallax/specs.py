from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from .canonical import canonical_digest
from .evolving_intent import Arm
from .swebench import (
    SWE_BENCH_DATASET,
    CommitSha,
    ImageDigest,
    InstanceId,
    SweScriptFamily,
)
from .types import (
    ConstructionSeed,
    DigestText,
    NonEmptyText,
    SourceId,
    StrictModel,
)

PositiveInt = Annotated[int, Field(gt=0)]


class PublicSourceV1(StrictModel):
    record_id: SourceId
    instance_id: InstanceId
    repo: NonEmptyText
    base_commit: CommitSha
    problem_statement: NonEmptyText
    version: NonEmptyText
    difficulty: str
    dataset: Literal["SWE-bench/SWE-bench_Verified"] = SWE_BENCH_DATASET
    dataset_revision: CommitSha


class PublicScriptV1(StrictModel):
    arm: Arm
    turns: Annotated[tuple[NonEmptyText, ...], Field(min_length=1)]
    agent_steps: Annotated[tuple[PositiveInt, ...], Field(min_length=1)]
    max_output_tokens: PositiveInt

    @model_validator(mode="after")
    def aligned_budget(self) -> Self:
        if len(self.turns) != len(self.agent_steps):
            raise ValueError("public script turns and budgets must align")
        return self

    @property
    def total_agent_steps(self) -> int:
        return sum(self.agent_steps)


class PublicTaskV1(StrictModel):
    source: PublicSourceV1
    construction_seed: ConstructionSeed
    scripts: Annotated[tuple[PublicScriptV1, ...], Field(min_length=3, max_length=3)]

    @model_validator(mode="after")
    def controlled_arms(self) -> Self:
        if tuple(script.arm for script in self.scripts) != (
            "static",
            "matched",
            "evolved",
        ):
            raise ValueError("public task must contain static, matched, evolved arms")
        budgets = {
            (script.total_agent_steps, script.max_output_tokens)
            for script in self.scripts
        }
        if len(budgets) != 1:
            raise ValueError("public task arms must have equal budgets")
        return self


class SealedAuthorityV1(StrictModel):
    harness_revision: CommitSha
    test_patch: NonEmptyText
    fail_to_pass: Annotated[tuple[NonEmptyText, ...], Field(min_length=1)]
    pass_to_pass: tuple[NonEmptyText, ...]


class TaskSpecV1(StrictModel):
    schema_version: Literal[1] = 1
    public: PublicTaskV1
    sealed: SealedAuthorityV1

    @property
    def public_digest(self) -> DigestText:
        return canonical_digest(self.public)

    @property
    def spec_digest(self) -> DigestText:
        return canonical_digest(self)


class ImageIdentityV1(StrictModel):
    ref: NonEmptyText
    digest: ImageDigest


class WorkspacePolicyV1(StrictModel):
    root: Literal["/testbed"] = "/testbed"
    guest_path: Literal["/workspace"] = "/workspace"
    network: Literal[False] = False
    shell_uid: Literal[1000] = 1000
    reset_to: CommitSha


class ToolDeclV1(StrictModel):
    name: NonEmptyText
    protocol: Literal["ssh/2", "mcp"]


class BudgetDeclV1(StrictModel):
    total_agent_steps: PositiveInt
    max_output_tokens: PositiveInt
    verifier_timeout_seconds: PositiveInt = 1800


class EnvSpecV1(StrictModel):
    schema_version: Literal[1] = 1
    image: ImageIdentityV1
    workspace: WorkspacePolicyV1
    tools: Annotated[tuple[ToolDeclV1, ...], Field(min_length=1)]
    budget: BudgetDeclV1

    @property
    def digest(self) -> DigestText:
        return canonical_digest(self)


def freeze_swe_specs(family: SweScriptFamily) -> tuple[TaskSpecV1, EnvSpecV1]:
    problem = family.static.problem
    verifier = problem.verifier
    public_scripts = tuple(
        PublicScriptV1(
            arm=script.arm,
            turns=tuple(turn.text for turn in script.turns),
            agent_steps=script.agent_steps,
            max_output_tokens=script.max_output_tokens,
        )
        for script in family.scripts
    )
    public = PublicTaskV1(
        source=PublicSourceV1(
            record_id=problem.record_id,
            instance_id=problem.instance_id,
            repo=problem.repo,
            base_commit=problem.base_commit,
            problem_statement=problem.problem_statement,
            version=problem.version,
            difficulty=problem.difficulty,
            dataset=problem.dataset,
            dataset_revision=problem.dataset_revision,
        ),
        construction_seed=family.construction_seed,
        scripts=public_scripts,
    )
    task = TaskSpecV1(
        public=public,
        sealed=SealedAuthorityV1(
            harness_revision=verifier.harness_revision,
            test_patch=verifier.test_patch,
            fail_to_pass=verifier.fail_to_pass,
            pass_to_pass=verifier.pass_to_pass,
        ),
    )
    env = EnvSpecV1(
        image=ImageIdentityV1(
            ref=verifier.image_ref,
            digest=verifier.image_digest,
        ),
        workspace=WorkspacePolicyV1(reset_to=problem.base_commit),
        tools=(
            ToolDeclV1(name="shell", protocol="ssh/2"),
            ToolDeclV1(name="director", protocol="mcp"),
        ),
        budget=BudgetDeclV1(
            total_agent_steps=family.static.total_agent_steps,
            max_output_tokens=family.static.max_output_tokens,
        ),
    )
    return task, env
