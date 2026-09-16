from __future__ import annotations

import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from itertools import pairwise
from pathlib import Path
from typing import Annotated, Literal, Self, TypeAlias

from pydantic import Field, ValidationError, model_validator

from .canonical import canonical_bytes, canonical_digest
from .perturbation import Condition, Turn, Variant, VariantSet
from .task import AgentContract
from .types import (
    DigestText,
    NonEmptyText,
    PositiveInt,
    SourceId,
    StrictModel,
)

Operator: TypeAlias = Literal[
    "core",
    "extension",
    "refinement",
    "input-source",
    "re-modality",
]
CaseCategory: TypeAlias = Literal["core", "functionality", "error"]
CaseRole: TypeAlias = Literal["new", "regression"]
CaseDetail: TypeAlias = Literal[
    "pass",
    "timeout",
    "exit-code-mismatch",
    "stdout-mismatch",
    "stderr-missing",
]
GateName: TypeAlias = Literal["gold-incremental", "no-op"]
ExitCode = Annotated[int, Field(ge=0, le=255)]
TimeoutSeconds = Annotated[float, Field(gt=0, le=120, allow_inf_nan=False)]

GATES: tuple[GateName, ...] = ("gold-incremental", "no-op")
MINIMUM_CHECKPOINTS = 3
MAXIMUM_CHECKPOINTS = 8

EVOLVED = Condition("evolved")
CARRY_REFERENCE = Condition("carry-reference")


class CheckpointError(ValueError):
    pass


class VerifierError(RuntimeError):
    pass


def _valid_relative_path(value: str) -> None:
    if "\x00" in value or "\\" in value:
        raise CheckpointError(f"path contains forbidden characters: {value!r}")
    if value.startswith("/") or value != value.strip():
        raise CheckpointError(f"path must be a trimmed relative path: {value!r}")
    segments = value.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise CheckpointError(f"path contains empty or traversal segments: {value!r}")


class WorkspaceFile(StrictModel):
    path: NonEmptyText
    content: str

    @model_validator(mode="after")
    def valid_file(self) -> Self:
        _valid_relative_path(self.path)
        if "\x00" in self.content:
            raise CheckpointError(f"file content contains NUL: {self.path}")
        return self

    @property
    def content_bytes(self) -> int:
        return len(self.content.encode())


class Workspace(StrictModel):
    files: tuple[WorkspaceFile, ...]

    @model_validator(mode="after")
    def ordered_unique_paths(self) -> Self:
        paths = tuple(file.path for file in self.files)
        if any(later <= earlier for earlier, later in pairwise(paths)):
            raise CheckpointError("workspace paths must be strictly ascending")
        return self

    @classmethod
    def from_files(cls, files: Mapping[str, str]) -> Self:
        return cls(
            files=tuple(
                WorkspaceFile(path=path, content=files[path]) for path in sorted(files)
            )
        )

    @property
    def content_bytes(self) -> int:
        return sum(file.content_bytes for file in self.files)

    @property
    def digest(self) -> str:
        return canonical_digest(self)


EMPTY_WORKSPACE = Workspace(files=())


class EntrypointContract(StrictModel):
    interpreter: Literal["python3"]
    entry_file: NonEmptyText
    timeout_seconds: TimeoutSeconds

    @model_validator(mode="after")
    def valid_entry(self) -> Self:
        _valid_relative_path(self.entry_file)
        return self


class SealedCase(StrictModel):
    case_id: NonEmptyText
    category: CaseCategory
    argv: tuple[str, ...]
    stdin_text: str
    input_files: tuple[WorkspaceFile, ...]
    expected_stdout: str
    expected_exit_code: ExitCode
    expect_stderr: bool

    @model_validator(mode="after")
    def unique_input_paths(self) -> Self:
        paths = tuple(file.path for file in self.input_files)
        if len(set(paths)) != len(paths):
            raise CheckpointError(
                f"case input file paths must be unique: {self.case_id}"
            )
        return self


class CheckpointSpec(StrictModel):
    index: PositiveInt
    operator: Operator
    public_spec: NonEmptyText
    max_output_bytes: PositiveInt
    cases: Annotated[tuple[SealedCase, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def graded_checkpoint(self) -> Self:
        identifiers = tuple(case.case_id for case in self.cases)
        if len(set(identifiers)) != len(identifiers):
            raise CheckpointError(f"checkpoint {self.index}: case ids must be unique")
        if all(case.category != "core" for case in self.cases):
            raise CheckpointError(
                f"checkpoint {self.index}: at least one core case is required"
            )
        return self

    @property
    def spec_digest(self) -> str:
        return canonical_digest(self.public_spec)


class CheckpointFamily(StrictModel):
    family_id: SourceId
    contract: EntrypointContract
    checkpoints: Annotated[
        tuple[CheckpointSpec, ...],
        Field(min_length=MINIMUM_CHECKPOINTS, max_length=MAXIMUM_CHECKPOINTS),
    ]

    @model_validator(mode="after")
    def coherent_family(self) -> Self:
        indices = tuple(checkpoint.index for checkpoint in self.checkpoints)
        if indices != tuple(range(1, len(self.checkpoints) + 1)):
            raise CheckpointError("checkpoint indices must be contiguous from 1")
        for checkpoint in self.checkpoints:
            if (checkpoint.index == 1) != (checkpoint.operator == "core"):
                raise CheckpointError(
                    "the first checkpoint, and only the first, is the core problem"
                )
        identifiers = [
            case.case_id for checkpoint in self.checkpoints for case in checkpoint.cases
        ]
        if len(set(identifiers)) != len(identifiers):
            raise CheckpointError("sealed case ids must be unique across the family")
        for checkpoint in self.checkpoints:
            for case in self._sealed_cases():
                if case.case_id in checkpoint.public_spec:
                    raise CheckpointError(
                        f"public spec {checkpoint.index} leaks sealed case id "
                        f"{case.case_id}"
                    )
                if canonical_bytes(case).decode() in checkpoint.public_spec:
                    raise CheckpointError(
                        f"public spec {checkpoint.index} leaks a sealed case body"
                    )
        return self

    def _sealed_cases(self) -> tuple[SealedCase, ...]:
        return tuple(
            case for checkpoint in self.checkpoints for case in checkpoint.cases
        )

    def obligations(self, index: int) -> tuple[tuple[int, SealedCase], ...]:
        if not 1 <= index <= len(self.checkpoints):
            raise CheckpointError(f"stage index out of range: {index}")
        return tuple(
            (checkpoint.index, case)
            for checkpoint in self.checkpoints
            if checkpoint.index <= index
            for case in checkpoint.cases
        )

    @property
    def digest(self) -> str:
        return canonical_digest(self)

    @property
    def task_id(self) -> SourceId:
        return self.family_id

    @property
    def public_digest(self) -> DigestText:
        """Cover exactly the specs and contract an agent may read.

        Deliberately excludes the sealed cases so that editing a hidden test
        does not change the family's public identity, which is the property the
        `Task` protocol requires.
        """

        return canonical_digest(
            {
                "contract": self.contract.model_dump(mode="json"),
                "family_id": self.family_id,
                "specs": [
                    {
                        "index": checkpoint.index,
                        "operator": checkpoint.operator,
                        "public_spec": checkpoint.public_spec,
                    }
                    for checkpoint in self.checkpoints
                ],
            }
        )

    @property
    def verifier_digest(self) -> DigestText:
        return canonical_digest(
            {
                "contract": CONTRACT.model_dump(mode="json"),
                "cases": [
                    case.model_dump(mode="json") for case in self._sealed_cases()
                ],
            }
        )

    @property
    def agent_contract(self) -> AgentContract:
        return CONTRACT


CONTRACT = AgentContract(
    instructions=(
        "Reply with the complete workspace as one JSON object: "
        '{"files": {"<relative path>": "<full file content>"}}. Include every '
        "file the program needs; any file you omit is deleted. Do not use "
        "Markdown fences and do not add commentary. The program must behave "
        "exactly as specified when run through the declared entry file."
    ),
)


class ReferenceBuild(StrictModel):
    family_digest: DigestText
    stages: Annotated[tuple[Workspace, ...], Field(min_length=1)]

    @property
    def digest(self) -> str:
        return canonical_digest(self)


class SeedFamilyFixture(StrictModel):
    family: CheckpointFamily
    references: ReferenceBuild


def load_seed_family(path: Path) -> SeedFamilyFixture:
    try:
        return SeedFamilyFixture.model_validate_json(path.read_bytes())
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise CheckpointError(f"seed family fixture is invalid: {detail}") from error


class CaseResult(StrictModel):
    case_id: NonEmptyText
    origin_index: PositiveInt
    role: CaseRole
    category: CaseCategory
    detail: CaseDetail

    @property
    def passed(self) -> bool:
        return self.detail == "pass"


class StageVerification(StrictModel):
    kind: Literal["stage_verification"] = "stage_verification"
    index: PositiveInt
    strict_pass: bool
    isolated_pass: bool
    core_pass: bool
    case_results: Annotated[tuple[CaseResult, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def consistent_verdicts(self) -> Self:
        new = tuple(result for result in self.case_results if result.role == "new")
        for result in self.case_results:
            if result.origin_index > self.index:
                raise CheckpointError(
                    f"stage {self.index} graded a future obligation: {result.case_id}"
                )
            if (result.role == "regression") != (result.origin_index < self.index):
                raise CheckpointError(
                    f"stage {self.index} mislabeled obligation role: {result.case_id}"
                )
        if not new:
            raise CheckpointError(f"stage {self.index} graded no new obligations")
        expectations = (
            (self.strict_pass, all(result.passed for result in self.case_results)),
            (self.isolated_pass, all(result.passed for result in new)),
            (
                self.core_pass,
                all(result.passed for result in new if result.category == "core"),
            ),
        )
        if any(recorded != computed for recorded, computed in expectations):
            raise CheckpointError(
                f"stage {self.index} verdict vector contradicts its case results"
            )
        return self


def materialize_case(
    root: Path,
    workspace: Workspace,
    case: SealedCase,
) -> None:
    for file in (*workspace.files, *case.input_files):
        target = root / file.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file.content, encoding="utf-8")


CaseExecution: TypeAlias = Callable[
    [EntrypointContract, Workspace, SealedCase], CaseDetail
]


def run_case_trusted(
    contract: EntrypointContract,
    workspace: Workspace,
    case: SealedCase,
) -> CaseDetail:
    """Host-subprocess execution for TRUSTED code only.

    Reference builds and scripted-fixture workspaces may run here; anything a
    real model wrote must go through the container path in
    `checkpoint_sandbox`, which this module never falls back to implicitly.
    """
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        materialize_case(root, workspace, case)
        try:
            completed = subprocess.run(
                (sys.executable, contract.entry_file, *case.argv),
                cwd=root,
                input=case.stdin_text,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=contract.timeout_seconds,
                env={"PYTHONHASHSEED": "0", "PYTHONIOENCODING": "utf-8"},
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        except OSError as error:
            raise VerifierError(
                f"case {case.case_id}: interpreter spawn failed"
            ) from error
    if completed.returncode != case.expected_exit_code:
        return "exit-code-mismatch"
    if completed.stdout != case.expected_stdout:
        return "stdout-mismatch"
    if case.expect_stderr and not completed.stderr.strip():
        return "stderr-missing"
    return "pass"


def verify_stage(
    family: CheckpointFamily,
    index: int,
    workspace: Workspace,
    *,
    execute: CaseExecution = run_case_trusted,
) -> StageVerification:
    results = tuple(
        CaseResult(
            case_id=case.case_id,
            origin_index=origin,
            role="new" if origin == index else "regression",
            category=case.category,
            detail=execute(family.contract, workspace, case),
        )
        for origin, case in family.obligations(index)
    )
    new = tuple(result for result in results if result.role == "new")
    return StageVerification(
        index=index,
        strict_pass=all(result.passed for result in results),
        isolated_pass=all(result.passed for result in new),
        core_pass=all(result.passed for result in new if result.category == "core"),
        case_results=results,
    )


class GateResult(StrictModel):
    gate: GateName
    passed: bool
    detail: NonEmptyText


class AdmissionReceipt(StrictModel):
    family_digest: DigestText
    reference_digest: DigestText
    gates: tuple[GateResult, ...]
    decision: Literal["admitted", "rejected"]

    @model_validator(mode="after")
    def sound_decision(self) -> Self:
        if tuple(result.gate for result in self.gates) != GATES:
            raise CheckpointError(
                "admission receipt must record every gate exactly once, in order"
            )
        expected = (
            "admitted" if all(result.passed for result in self.gates) else "rejected"
        )
        if self.decision != expected:
            raise CheckpointError(
                "admission decision contradicts the recorded gate results"
            )
        return self


def _require_aligned(family: CheckpointFamily, references: ReferenceBuild) -> None:
    """Reject a mismatched reference build before running anything.

    This was a gate. It is a precondition: nothing downstream can produce a
    meaningful result from references bound to a different family, so recording
    it as a failed gate only obscured which of the two real gates was tried.
    """

    if references.family_digest != family.digest:
        raise CheckpointError("reference build is bound to a different family digest")
    if len(references.stages) != len(family.checkpoints):
        raise CheckpointError(
            f"reference stages ({len(references.stages)}) do not cover the "
            f"{len(family.checkpoints)} checkpoints"
        )


def _gate_gold(family: CheckpointFamily, references: ReferenceBuild) -> GateResult:
    failures = []
    for checkpoint in family.checkpoints:
        verification = verify_stage(
            family, checkpoint.index, references.stages[checkpoint.index - 1]
        )
        if not verification.strict_pass:
            failed = tuple(
                result.case_id
                for result in verification.case_results
                if not result.passed
            )
            failures.append(f"stage {checkpoint.index} failed {failed}")
    if failures:
        return GateResult(
            gate="gold-incremental", passed=False, detail="; ".join(failures)
        )
    return GateResult(
        gate="gold-incremental",
        passed=True,
        detail="incremental references pass accumulated obligations at every stage",
    )


def _gate_no_op(family: CheckpointFamily, references: ReferenceBuild) -> GateResult:
    vacuous = []
    for checkpoint in family.checkpoints:
        prior = (
            EMPTY_WORKSPACE
            if checkpoint.index == 1
            else references.stages[checkpoint.index - 2]
        )
        if verify_stage(family, checkpoint.index, prior).isolated_pass:
            vacuous.append(f"stage {checkpoint.index} demands no new work")
    if vacuous:
        return GateResult(gate="no-op", passed=False, detail="; ".join(vacuous))
    return GateResult(
        gate="no-op",
        passed=True,
        detail="every checkpoint fails on the prior stage's reference workspace",
    )


def admit_family(
    family: CheckpointFamily, references: ReferenceBuild
) -> AdmissionReceipt:
    """Prove the family's obligations accumulate, then that they bite.

    `gold-incremental` requires the reference solution for each stage to satisfy
    every obligation accrued so far; `no-op` requires the previous stage's
    reference to fail the current stage. A family that passes both demands new
    work at every step and grades it against everything that came before.
    """

    _require_aligned(family, references)
    gates = (
        _gate_gold(family, references),
        _gate_no_op(family, references),
    )
    decision: Literal["admitted", "rejected"] = (
        "admitted" if all(result.passed for result in gates) else "rejected"
    )
    return AdmissionReceipt(
        family_digest=family.digest,
        reference_digest=references.digest,
        gates=gates,
        decision=decision,
    )


def build_checkpoint_variants(
    family: CheckpointFamily,
    references: ReferenceBuild,
) -> VariantSet:
    """Turn one admitted family into two reference-free conditions.

    Both conditions walk the same stages under the same obligations. The
    `evolved` condition carries its own accumulated workspace forward; the
    `carry-reference` condition is handed the previous stage's reference
    workspace instead, so only the former has to reproduce its own prior work.

    That asymmetry is why `required_output` exists. Screening gave both
    conditions the same flat byte cap, which sounds matched and is not: the
    evolved condition had to spend part of its cap re-serializing a workspace
    that the control was simply given, and it failed 10/10 on the cap rather
    than on the task. Here each condition's limit is its own carrying cost plus
    the checkpoint's declared headroom, so the room to do new work is equal by
    construction and the difference in limits is visible in the plan.
    """

    _require_aligned(family, references)
    carried = (0, *(stage.content_bytes for stage in references.stages[:-1]))
    return VariantSet(
        task_id=family.family_id,
        provenance="reference_free",
        agent_contract=CONTRACT,
        variants=(
            Variant(
                condition=CARRY_REFERENCE,
                turns=tuple(
                    Turn(
                        text=checkpoint.public_spec,
                        required_output=0,
                        headroom=checkpoint.max_output_bytes,
                    )
                    for checkpoint in family.checkpoints
                ),
            ),
            Variant(
                condition=EVOLVED,
                turns=tuple(
                    Turn(
                        text=checkpoint.public_spec,
                        required_output=carried[checkpoint.index - 1],
                        headroom=checkpoint.max_output_bytes,
                    )
                    for checkpoint in family.checkpoints
                ),
            ),
        ),
    )
