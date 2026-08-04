from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from typing import Annotated, Literal, NewType, Self, TypeAlias

from pydantic import (
    Field,
    JsonValue,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from .canonical import canonical_digest
from .evolving_intent import Arm, Chat, Message
from .hud_wire import WireFormatError, parse_wire
from .types import (
    DigestText,
    NonEmptyText,
    PositiveInt,
    SourceId,
    StrictModel,
)

SWE_BENCH_DATASET = "SWE-bench/SWE-bench_Verified"
SWE_BENCH_REVISION = "91aa3ed51b709be6457e12d00300a6a596d4c6a3"
SWE_BENCH_HARNESS_REVISION = "f7bbbb2ccdf479001d6467c9e34af59e44a840f9"
UPSTREAM_EVOLVING_INTENT_REVISION = "993d6be9597ac03854b46362ccd647eb1bfd267a"

PUBLISHED_INSTANCE_IDS = (
    "astropy__astropy-13236",
    "astropy__astropy-14508",
    "astropy__astropy-14995",
    "astropy__astropy-8707",
    "django__django-10914",
    "django__django-11066",
    "django__django-11163",
    "django__django-12143",
    "django__django-13089",
    "django__django-13343",
    "django__django-13410",
    "django__django-13658",
    "django__django-13786",
    "django__django-14493",
    "django__django-14608",
    "django__django-14765",
    "django__django-15368",
    "django__django-15569",
    "django__django-15572",
    "matplotlib__matplotlib-14623",
    "matplotlib__matplotlib-20676",
    "matplotlib__matplotlib-20859",
    "matplotlib__matplotlib-22871",
    "mwaskom__seaborn-3069",
    "psf__requests-1724",
    "psf__requests-5414",
    "pydata__xarray-4695",
    "pydata__xarray-6461",
    "pydata__xarray-6721",
    "pydata__xarray-6992",
    "pylint-dev__pylint-6528",
    "pylint-dev__pylint-6903",
    "pylint-dev__pylint-7080",
    "pylint-dev__pylint-7277",
    "pytest-dev__pytest-5809",
    "pytest-dev__pytest-6202",
    "scikit-learn__scikit-learn-12973",
    "scikit-learn__scikit-learn-14087",
    "scikit-learn__scikit-learn-14496",
    "scikit-learn__scikit-learn-14894",
    "sphinx-doc__sphinx-10466",
    "sphinx-doc__sphinx-7910",
    "sphinx-doc__sphinx-8269",
    "sphinx-doc__sphinx-9230",
    "sphinx-doc__sphinx-9320",
    "sphinx-doc__sphinx-9591",
    "sympy__sympy-12489",
    "sympy__sympy-13091",
    "sympy__sympy-13372",
    "sympy__sympy-15599",
)

InstanceId = NewType("InstanceId", NonEmptyText)
ImageDigest = NewType("ImageDigest", DigestText)
CommitSha = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
ArgumentCategory: TypeAlias = Literal[
    "symptom",
    "context",
    "constraint",
    "implementation",
]


class SweBenchError(ValueError):
    pass


class VerifierRuntime(StrictModel):
    image_digest: ImageDigest


class SweBenchVerifier(StrictModel):
    harness_revision: CommitSha
    image_ref: NonEmptyText
    image_digest: ImageDigest
    gold_patch: NonEmptyText
    test_patch: NonEmptyText
    fail_to_pass: Annotated[tuple[NonEmptyText, ...], Field(min_length=1)]
    pass_to_pass: tuple[NonEmptyText, ...]

    @property
    def digest(self) -> str:
        return canonical_digest(self)


class SweBenchProblem(StrictModel):
    kind: Literal["swebench"] = "swebench"
    record_id: SourceId
    instance_id: InstanceId
    repo: NonEmptyText
    base_commit: CommitSha
    problem_statement: NonEmptyText
    version: NonEmptyText
    difficulty: str
    dataset: Literal["SWE-bench/SWE-bench_Verified"] = SWE_BENCH_DATASET
    dataset_revision: CommitSha = SWE_BENCH_REVISION
    verifier: SweBenchVerifier

    @property
    def public_digest(self) -> str:
        return canonical_digest(
            self.model_dump(
                mode="json",
                exclude={"verifier"},
            )
        )


class _DatasetRow(StrictModel):
    repo: NonEmptyText
    instance_id: InstanceId
    base_commit: CommitSha
    patch: NonEmptyText
    test_patch: NonEmptyText
    problem_statement: NonEmptyText
    hints_text: str
    created_at: str
    version: NonEmptyText
    FAIL_TO_PASS: tuple[NonEmptyText, ...]
    PASS_TO_PASS: tuple[NonEmptyText, ...]
    environment_setup_commit: str
    difficulty: str

    @field_validator("FAIL_TO_PASS", "PASS_TO_PASS", mode="before")
    @classmethod
    def parse_test_list(cls, value: object) -> object:
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError as error:
                raise ValueError("test list must be valid JSON") from error
            if not isinstance(parsed, list):
                raise ValueError("test list must decode to an array")
            return tuple(parsed)
        return value


class _FilteredRow(StrictModel):
    row_idx: Annotated[int, Field(ge=0)]
    row: _DatasetRow
    truncated_cells: tuple[JsonValue, ...]


class _Feature(StrictModel):
    feature_idx: Annotated[int, Field(ge=0)]
    name: NonEmptyText
    type: dict[str, JsonValue]


class _FilterResponse(StrictModel):
    features: tuple[_Feature, ...]
    rows: tuple[_FilteredRow, ...]
    num_rows_total: Annotated[int, Field(ge=0)]
    num_rows_per_page: PositiveInt
    partial: bool


class _RevisionResponse(StrictModel):
    dataset_object_id: str | None = Field(default=None, alias="_id")
    id: str | None = None
    sha: CommitSha


Fetch: TypeAlias = Callable[[str], bytes]


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def official_image_ref(instance_id: InstanceId) -> str:
    tag = str(instance_id).replace("__", "_1776_")
    return f"swebench/sweb.eval.x86_64.{tag}"


def load_swebench_rows(
    rows: Iterable[object],
    instance_ids: tuple[str, ...],
    *,
    runtimes: Mapping[str, VerifierRuntime],
    dataset_revision: str = SWE_BENCH_REVISION,
    harness_revision: str = SWE_BENCH_HARNESS_REVISION,
) -> tuple[SweBenchProblem, ...]:
    requested = tuple(InstanceId(value) for value in instance_ids)
    if not requested or len(set(requested)) != len(requested):
        raise SweBenchError("instance ids must be non-empty and unique")
    unknown = set(requested) - set(PUBLISHED_INSTANCE_IDS)
    if unknown:
        raise SweBenchError(f"instance ids are not in the published set: {unknown}")
    parsed: dict[InstanceId, _DatasetRow] = {}
    for value in rows:
        try:
            row = _DatasetRow.model_validate(value)
        except ValidationError as error:
            detail = error.errors(include_url=False)[0]["msg"]
            raise SweBenchError(f"invalid SWE-bench row: {detail}") from error
        if row.instance_id in parsed:
            raise SweBenchError(f"duplicate dataset row: {row.instance_id}")
        parsed[row.instance_id] = row
    missing = set(requested) - set(parsed)
    if missing:
        raise SweBenchError(f"missing requested dataset rows: {missing}")
    missing_runtime = set(requested) - set(runtimes)
    if missing_runtime:
        raise SweBenchError(f"missing verifier runtime: {missing_runtime}")
    problems: list[SweBenchProblem] = []
    for instance_id in requested:
        row = parsed[instance_id]
        runtime = runtimes[instance_id]
        verifier = SweBenchVerifier(
            harness_revision=harness_revision,
            image_ref=official_image_ref(instance_id),
            image_digest=runtime.image_digest,
            gold_patch=row.patch,
            test_patch=row.test_patch,
            fail_to_pass=row.FAIL_TO_PASS,
            pass_to_pass=row.PASS_TO_PASS,
        )
        problems.append(
            SweBenchProblem(
                record_id=SourceId(f"swebench:{instance_id}"),
                instance_id=instance_id,
                repo=row.repo,
                base_commit=row.base_commit,
                problem_statement=row.problem_statement,
                version=row.version,
                difficulty=row.difficulty,
                dataset_revision=dataset_revision,
                verifier=verifier,
            )
        )
    return tuple(problems)


def fetch_swebench_verified(
    instance_ids: tuple[str, ...],
    *,
    runtimes: Mapping[str, VerifierRuntime],
    fetch: Fetch = _fetch,
    dataset_revision: str = SWE_BENCH_REVISION,
) -> tuple[SweBenchProblem, ...]:
    unknown = set(instance_ids) - set(PUBLISHED_INSTANCE_IDS)
    if unknown:
        raise SweBenchError(f"instance ids are not in the published set: {unknown}")
    revision_url = (
        "https://huggingface.co/api/datasets/"
        f"{SWE_BENCH_DATASET}/revision/{dataset_revision}?expand=sha"
    )
    try:
        before = _RevisionResponse.model_validate_json(fetch(revision_url))
    except ValidationError as error:
        raise SweBenchError("invalid Hugging Face revision response") from error
    if before.sha != dataset_revision:
        raise SweBenchError(
            f"dataset revision drift: expected={dataset_revision}, actual={before.sha}"
        )
    predicate = " OR ".join(
        f"\"instance_id\"='{value}'" for value in sorted(instance_ids)
    )
    where = urllib.parse.quote(predicate, safe="")
    rows_url = (
        "https://datasets-server.huggingface.co/filter?"
        f"dataset={urllib.parse.quote(SWE_BENCH_DATASET, safe='')}"
        f"&config=default&split=test&where={where}"
        f"&revision={dataset_revision}"
    )
    try:
        response = _FilterResponse.model_validate_json(fetch(rows_url))
        after = _RevisionResponse.model_validate_json(fetch(revision_url))
    except ValidationError as error:
        raise SweBenchError("invalid Hugging Face dataset response") from error
    if response.partial:
        raise SweBenchError("Hugging Face returned a partial dataset response")
    truncated = {
        item.row_idx: item.truncated_cells
        for item in response.rows
        if item.truncated_cells
    }
    if truncated:
        raise SweBenchError(f"Hugging Face truncated dataset cells: {truncated}")
    if after.sha != before.sha:
        raise SweBenchError(
            f"dataset revision changed while reading: before={before.sha}, "
            f"after={after.sha}"
        )
    return load_swebench_rows(
        (item.row for item in response.rows),
        instance_ids,
        runtimes=runtimes,
        dataset_revision=dataset_revision,
    )


class SweArgument(StrictModel):
    identifier: NonEmptyText
    value: NonEmptyText
    category: ArgumentCategory

    @field_validator("value", mode="before")
    @classmethod
    def scalar_value_as_text(cls, value: object) -> object:
        if isinstance(value, bool | int | float):
            return json.dumps(value, allow_nan=False, separators=(",", ":"))
        return value


class SweIntent(StrictModel):
    function: NonEmptyText
    arguments: tuple[SweArgument, ...]

    @model_validator(mode="after")
    def unique_arguments(self) -> Self:
        identifiers = tuple(argument.identifier for argument in self.arguments)
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("intent argument identifiers must be unique")
        return self


class SweConstruction(StrictModel):
    source: SweIntent
    predecessors: Annotated[tuple[SweIntent, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def changing_functions(self) -> Self:
        functions = tuple(item.function for item in (*self.predecessors, self.source))
        if len(set(functions)) != len(functions):
            raise ValueError("predecessor functions must be distinct")
        return self


class SweConstructionEvidence(StrictModel):
    model: NonEmptyText
    output: str
    construction: SweConstruction


def construct_swe_intent(
    problem: SweBenchProblem,
    chat: Chat,
    *,
    model: str,
    max_output_tokens: int = 1024,
) -> SweConstructionEvidence:
    messages = (
        Message(
            role="system",
            content=(
                "Extract one source software intent and one immediate predecessor. "
                'Return only JSON with top-level keys "source" and "predecessors". '
                "Do not use Markdown fences. Each intent has exactly function and "
                "arguments. Each argument has exactly identifier, value, and "
                "category. Value is always a JSON string, including booleans and "
                "numbers. Category is symptom, context, constraint, or implementation."
            ),
        ),
        Message(
            role="user",
            content=json.dumps(
                {
                    "instance_id": problem.instance_id,
                    "problem_statement": problem.problem_statement,
                    "repo": problem.repo,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        ),
    )
    output = chat(messages, max_output_tokens)
    try:
        construction = parse_wire(SweConstruction, output)
    except WireFormatError as error:
        raise SweBenchError(f"SWE intent construction is invalid: {error}") from error
    return SweConstructionEvidence(
        model=model,
        output=output,
        construction=construction,
    )


class SweIntentState(StrictModel):
    intent: SweIntent
    revealed_identifiers: tuple[str, ...]

    @model_validator(mode="after")
    def valid_reveals(self) -> Self:
        identifiers = {argument.identifier for argument in self.intent.arguments}
        if set(self.revealed_identifiers) != identifiers:
            raise ValueError("SWE phase state must reveal its full intent")
        return self


class SweTurn(StrictModel):
    text: NonEmptyText
    state_after: SweIntentState


class SweScript(StrictModel):
    arm: Arm
    problem: SweBenchProblem
    turns: Annotated[tuple[SweTurn, ...], Field(min_length=1)]
    agent_steps: tuple[PositiveInt, ...]
    max_output_tokens: PositiveInt

    @model_validator(mode="after")
    def aligned_budget(self) -> Self:
        if len(self.turns) != len(self.agent_steps):
            raise ValueError("turns and step allocations must align")
        derived = (
            value
            for value in (
                *self.problem.verifier.fail_to_pass,
                *self.problem.verifier.pass_to_pass,
            )
            if value not in self.problem.problem_statement
        )
        sealed = (self.problem.verifier.test_patch, *derived)
        if any(value and value in turn.text for value in sealed for turn in self.turns):
            raise ValueError("agent turn contains sealed verifier material")
        return self

    @property
    def total_agent_steps(self) -> int:
        return sum(self.agent_steps)


class SweOverlayReceipt(StrictModel):
    upstream_revision: Literal["993d6be9597ac03854b46362ccd647eb1bfd267a"] = (
        UPSTREAM_EVOLVING_INTENT_REVISION
    )
    stripped_symptoms: tuple[tuple[str, tuple[str, ...]], ...]
    injected_argument_order: tuple[tuple[str, tuple[str, ...]], ...]


class SweScriptFamily(StrictModel):
    construction: SweConstruction
    static: SweScript
    matched: SweScript
    evolved: SweScript
    overlay: SweOverlayReceipt

    @model_validator(mode="after")
    def controlled_family(self) -> Self:
        scripts = (self.static, self.matched, self.evolved)
        if tuple(script.arm for script in scripts) != (
            "static",
            "matched",
            "evolved",
        ):
            raise ValueError("SWE family must contain all three arms")
        if any(script.problem != self.static.problem for script in scripts):
            raise ValueError("SWE arms must share one source and verifier")
        budgets = {
            (script.total_agent_steps, script.max_output_tokens) for script in scripts
        }
        if len(budgets) != 1:
            raise ValueError("SWE arms must have equal episode budgets")
        if len(self.matched.turns) != len(self.evolved.turns):
            raise ValueError("matched and evolved turn counts must match")
        if self.matched.agent_steps != self.evolved.agent_steps:
            raise ValueError("matched and evolved per-turn budgets must match")
        source = self.construction.source
        if self.evolved.turns[-1].state_after.intent != source:
            raise ValueError("evolved arm does not restore source intent")
        if any(turn.state_after.intent != source for turn in self.matched.turns):
            raise ValueError("matched arm changes source intent")
        return self

    @property
    def scripts(self) -> tuple[SweScript, SweScript, SweScript]:
        return self.static, self.matched, self.evolved


def _ordered(intent: SweIntent) -> tuple[SweArgument, ...]:
    symptoms = tuple(
        argument for argument in intent.arguments if argument.category == "symptom"
    )
    scheduled = tuple(
        argument for argument in intent.arguments if argument.category != "symptom"
    )
    return (*symptoms, *scheduled)


def _render_arguments(intent: SweIntent) -> str:
    return " ".join(
        f"{argument.identifier.replace('_', ' ')}: {argument.value}."
        for argument in _ordered(intent)
    )


def _state(intent: SweIntent) -> SweIntentState:
    return SweIntentState(
        intent=intent,
        revealed_identifiers=tuple(
            argument.identifier for argument in intent.arguments
        ),
    )


def _allocate_steps(total: int, turns: int) -> tuple[int, ...]:
    if total < turns:
        raise SweBenchError("total agent steps must cover every turn")
    base, remainder = divmod(total, turns)
    return tuple(base + int(index < remainder) for index in range(turns))


def build_swe_script_family(
    problem: SweBenchProblem,
    construction: SweConstruction,
    *,
    total_agent_steps: int,
    max_output_tokens: int,
) -> SweScriptFamily:
    phases = (*construction.predecessors, construction.source)
    evolved_turns = tuple(
        SweTurn(
            text=(
                (
                    f"Work toward this intermediate intent: {intent.function}. "
                    f"{_render_arguments(intent)} Do not implement the final issue yet."
                )
                if index < len(phases) - 1
                else (
                    f"{problem.problem_statement}\n\n"
                    f"The final intent is {intent.function}. "
                    f"{_render_arguments(intent)} Implement it now and run "
                    "focused tests."
                )
            ),
            state_after=_state(intent),
        )
        for index, intent in enumerate(phases)
    )
    matched_turns = tuple(
        SweTurn(
            text=(
                f"{problem.problem_statement}\n\n"
                f"The unchanged intent is {construction.source.function}. "
                f"{_render_arguments(construction.source)} "
                + (
                    "Inspect the repository without changing the requirements."
                    if index < len(phases) - 1
                    else "Implement the unchanged issue now and run focused tests."
                )
            ),
            state_after=_state(construction.source),
        )
        for index in range(len(phases))
    )
    static_turns = (
        SweTurn(
            text=problem.problem_statement,
            state_after=_state(construction.source),
        ),
    )
    static = SweScript(
        arm="static",
        problem=problem,
        turns=static_turns,
        agent_steps=(total_agent_steps,),
        max_output_tokens=max_output_tokens,
    )
    matched = SweScript(
        arm="matched",
        problem=problem,
        turns=matched_turns,
        agent_steps=_allocate_steps(total_agent_steps, len(matched_turns)),
        max_output_tokens=max_output_tokens,
    )
    evolved = SweScript(
        arm="evolved",
        problem=problem,
        turns=evolved_turns,
        agent_steps=_allocate_steps(total_agent_steps, len(evolved_turns)),
        max_output_tokens=max_output_tokens,
    )
    overlay = SweOverlayReceipt(
        stripped_symptoms=tuple(
            (
                intent.function,
                tuple(
                    argument.identifier
                    for argument in intent.arguments
                    if argument.category == "symptom"
                ),
            )
            for intent in phases
        ),
        injected_argument_order=tuple(
            (
                intent.function,
                tuple(argument.identifier for argument in _ordered(intent)),
            )
            for intent in phases
        ),
    )
    return SweScriptFamily(
        construction=construction,
        static=static,
        matched=matched,
        evolved=evolved,
        overlay=overlay,
    )
