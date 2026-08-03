from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .outcome import Verdict, Verification
from .specs import EnvSpecV1, TaskSpecV1
from .swebench import SWE_BENCH_HARNESS_REVISION
from .types import DigestText, NonEmptyText, StrictModel

CommandRunner = Callable[
    [list[str], Path, int],
    subprocess.CompletedProcess[str],
]


class OfficialHarnessError(RuntimeError):
    pass


class _WireModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="ignore")


class _Transition(_WireModel):
    success: tuple[str, ...]
    failure: tuple[str, ...]


class _OfficialReport(_WireModel):
    patch_exists: bool
    patch_successfully_applied: bool
    resolved: bool
    tests_status: dict[str, _Transition]


class _OfficialSummary(_WireModel):
    empty_patch_ids: tuple[str, ...] = ()


class HarnessEvaluation(StrictModel):
    outcome: Verification
    report_digest: DigestText
    harness_revision: NonEmptyText
    image_digest: DigestText
    fail_to_pass_success: tuple[str, ...]
    pass_to_pass_success: tuple[str, ...]


def _run(
    argv: list[str],
    cwd: Path,
    timeout: int,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def _dataset_row(task: TaskSpecV1) -> dict[str, object]:
    source = task.public.source
    sealed = task.sealed
    return {
        "instance_id": source.instance_id,
        "repo": source.repo,
        "version": source.version,
        "base_commit": source.base_commit,
        "problem_statement": source.problem_statement,
        "hints_text": "",
        "test_patch": sealed.test_patch,
        "FAIL_TO_PASS": list(sealed.fail_to_pass),
        "PASS_TO_PASS": list(sealed.pass_to_pass),
    }


def _invoke(
    argv: list[str],
    *,
    cwd: Path,
    timeout: int,
    runner: CommandRunner,
    purpose: str,
) -> subprocess.CompletedProcess[str]:
    try:
        result = runner(argv, cwd, timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OfficialHarnessError(f"{purpose} failed: {error}") from error
    if result.returncode:
        raise OfficialHarnessError(
            f"{purpose} failed with exit {result.returncode}: {result.stderr}"
        )
    return result


def run_official_harness(
    task: TaskSpecV1,
    environment: EnvSpecV1,
    model_patch: str,
    *,
    model: str,
    run_directory: Path,
    harness_source_directory: Path | None = None,
    timeout_seconds: Annotated[int, Field(gt=0)] = 1800,
    runner: CommandRunner = _run,
) -> HarnessEvaluation:
    source = task.public.source
    sealed = task.sealed
    run_directory = run_directory.resolve()
    run_id = f"parallax-{source.instance_id}"
    if sealed.harness_revision != SWE_BENCH_HARNESS_REVISION:
        raise OfficialHarnessError(
            "problem harness revision is not the pinned revision"
        )
    existing_reports = (
        tuple(run_directory.glob(f"**/{source.instance_id}/report.json"))
        if run_directory.exists()
        else ()
    )
    existing_summaries = (
        tuple(run_directory.glob(f"*.{run_id}.json")) if run_directory.exists() else ()
    )
    if (
        run_directory.exists()
        and not existing_reports
        and not existing_summaries
        and any(run_directory.iterdir())
    ):
        raise OfficialHarnessError("incomplete previous official harness directory")
    run_directory.mkdir(parents=True, exist_ok=True)
    dataset_path = run_directory / "dataset.json"
    predictions_path = run_directory / "predictions.jsonl"
    atomic_write(dataset_path, canonical_bytes([_dataset_row(task)]) + b"\n")
    prediction = {
        "instance_id": source.instance_id,
        "model_name_or_path": model,
        "model_patch": model_patch,
    }
    atomic_write(predictions_path, canonical_bytes(prediction) + b"\n")
    image = f"{environment.image.ref}@sha256:{environment.image.digest}"
    image_tag = f"{environment.image.ref}:latest"
    harness_source = (
        harness_source_directory
        if harness_source_directory is not None
        else run_directory.parent / "swebench-harness-source"
    ).resolve()
    if not existing_reports:
        _invoke(
            ["docker", "pull", image],
            cwd=run_directory,
            timeout=timeout_seconds,
            runner=runner,
            purpose="pinned image pull",
        )
        _invoke(
            ["docker", "tag", image, image_tag],
            cwd=run_directory,
            timeout=60,
            runner=runner,
            purpose="pinned image tagging",
        )
        if harness_source.exists():
            revision = _invoke(
                ["git", "-C", str(harness_source), "rev-parse", "HEAD"],
                cwd=harness_source.parent,
                timeout=60,
                runner=runner,
                purpose="pinned harness revision check",
            )
            if revision.stdout.strip() != SWE_BENCH_HARNESS_REVISION:
                raise OfficialHarnessError("harness source revision is not pinned")
        else:
            harness_source.parent.mkdir(parents=True, exist_ok=True)
            _invoke(
                [
                    "git",
                    "clone",
                    "--filter=blob:none",
                    "--no-checkout",
                    "https://github.com/SWE-bench/SWE-bench.git",
                    str(harness_source),
                ],
                cwd=harness_source.parent,
                timeout=timeout_seconds,
                runner=runner,
                purpose="pinned harness clone",
            )
            _invoke(
                [
                    "git",
                    "-C",
                    str(harness_source),
                    "checkout",
                    "--detach",
                    SWE_BENCH_HARNESS_REVISION,
                ],
                cwd=harness_source.parent,
                timeout=timeout_seconds,
                runner=runner,
                purpose="pinned harness checkout",
            )
        command = [
            "uv",
            "run",
            "--with-editable",
            str(harness_source),
            "python",
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            str(dataset_path),
            "--split",
            "test",
            "--predictions_path",
            str(predictions_path),
            "--instance_ids",
            source.instance_id,
            "--max_workers",
            "1",
            "--run_id",
            run_id,
            "--namespace",
            "swebench",
            "--instance_image_tag",
            "latest",
            "--cache_level",
            "instance",
            "--clean",
            "false",
            "--timeout",
            str(timeout_seconds),
        ]
        _invoke(
            command,
            cwd=run_directory,
            timeout=timeout_seconds + 300,
            runner=runner,
            purpose="official SWE-bench harness",
        )
    reports = existing_reports or tuple(
        run_directory.glob(f"**/{source.instance_id}/report.json")
    )
    if not reports:
        summaries = existing_summaries or tuple(run_directory.glob(f"*.{run_id}.json"))
        if len(summaries) == 1:
            summary_bytes = summaries[0].read_bytes()
            try:
                summary = _OfficialSummary.model_validate_json(summary_bytes)
            except ValueError as error:
                raise OfficialHarnessError(
                    "official harness summary is invalid"
                ) from error
            if source.instance_id in summary.empty_patch_ids:
                return HarnessEvaluation(
                    outcome=Verification(
                        verdict=Verdict.WRONG,
                        reason="official SWE-bench harness classified an empty patch",
                    ),
                    report_digest=canonical_digest(json.loads(summary_bytes)),
                    harness_revision=SWE_BENCH_HARNESS_REVISION,
                    image_digest=environment.image.digest,
                    fail_to_pass_success=(),
                    pass_to_pass_success=(),
                )
    if len(reports) != 1:
        raise OfficialHarnessError(
            f"official harness produced {len(reports)} instance reports"
        )
    report_bytes = reports[0].read_bytes()
    try:
        envelope = json.loads(report_bytes)
        report = _OfficialReport.model_validate_json(
            json.dumps(envelope[source.instance_id])
        )
    except (KeyError, TypeError, ValueError) as error:
        raise OfficialHarnessError("official harness report is invalid") from error
    statuses = report.tests_status
    try:
        fail_to_pass = statuses["FAIL_TO_PASS"]
        pass_to_pass = statuses["PASS_TO_PASS"]
    except KeyError as error:
        raise OfficialHarnessError(
            "official harness omitted test transitions"
        ) from error
    observed_fail = set(fail_to_pass.success) | set(fail_to_pass.failure)
    observed_pass = set(pass_to_pass.success) | set(pass_to_pass.failure)
    if observed_fail != set(sealed.fail_to_pass):
        raise OfficialHarnessError("official harness FAIL_TO_PASS coverage drift")
    if observed_pass != set(sealed.pass_to_pass):
        raise OfficialHarnessError("official harness PASS_TO_PASS coverage drift")
    if not report.patch_exists or not report.patch_successfully_applied:
        verdict = Verdict.WRONG
        reason = "candidate patch was absent or did not apply"
    elif report.resolved:
        verdict = Verdict.PASS
        reason = "pinned official SWE-bench harness resolved the instance"
    else:
        verdict = Verdict.WRONG
        reason = "pinned official SWE-bench harness did not resolve the instance"
    return HarnessEvaluation(
        outcome=Verification(verdict=verdict, reason=reason),
        report_digest=canonical_digest(envelope),
        harness_revision=SWE_BENCH_HARNESS_REVISION,
        image_digest=environment.image.digest,
        fail_to_pass_success=fail_to_pass.success,
        pass_to_pass_success=pass_to_pass.success,
    )
