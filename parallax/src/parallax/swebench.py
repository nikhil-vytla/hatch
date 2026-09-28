"""SWE-bench Verified as a `Task`: the issue is public, the tests are sealed."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from typing import Annotated, NewType, TypeAlias

from pydantic import (
    Field,
    JsonValue,
    StringConstraints,
    ValidationError,
    field_validator,
)

from .canonical import canonical_digest
from .task import AgentContract
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

WORKSPACE_ROOT = "/testbed"
CONTRACT = AgentContract(
    instructions=(
        f"Your submission is the working tree at {WORKSPACE_ROOT}. Edit the "
        "repository source in place; the harness exports your changes as a git "
        "diff when the episode ends, so anything you do not write to disk is "
        "not submitted. Do not edit or add test files, and do not commit."
    ),
)


class SweBenchError(ValueError):
    pass


class VerifierRuntime(StrictModel):
    image_digest: ImageDigest


class SweBenchVerifier(StrictModel):
    """The sealed grading authority: gold patch, test patch, and test sets."""

    harness_revision: CommitSha
    image_ref: NonEmptyText
    image_digest: ImageDigest
    gold_patch: NonEmptyText
    test_patch: NonEmptyText
    fail_to_pass: Annotated[tuple[NonEmptyText, ...], Field(min_length=1)]
    pass_to_pass: tuple[NonEmptyText, ...]

    @property
    def digest(self) -> DigestText:
        return canonical_digest(self)


class SweBenchTask(StrictModel):
    record_id: SourceId
    instance_id: InstanceId
    repo: NonEmptyText
    base_commit: CommitSha
    problem_statement: NonEmptyText
    version: NonEmptyText
    difficulty: str
    dataset: NonEmptyText = SWE_BENCH_DATASET
    dataset_revision: CommitSha = SWE_BENCH_REVISION
    verifier: SweBenchVerifier

    @property
    def task_id(self) -> SourceId:
        return self.record_id

    @property
    def public_digest(self) -> DigestText:
        return canonical_digest(self.model_dump(mode="json", exclude={"verifier"}))

    @property
    def verifier_digest(self) -> DigestText:
        return self.verifier.digest

    @property
    def agent_contract(self) -> AgentContract:
        return CONTRACT


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
) -> tuple[SweBenchTask, ...]:
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
    tasks: list[SweBenchTask] = []
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
        tasks.append(
            SweBenchTask(
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
    return tuple(tasks)


def fetch_swebench_verified(
    instance_ids: tuple[str, ...],
    *,
    runtimes: Mapping[str, VerifierRuntime],
    fetch: Fetch = _fetch,
    dataset_revision: str = SWE_BENCH_REVISION,
) -> tuple[SweBenchTask, ...]:
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
