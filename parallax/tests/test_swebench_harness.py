from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID
from test_swebench_env import family

from parallax.outcome import Verdict
from parallax.specs import freeze_swe_specs
from parallax.swebench import SWE_BENCH_HARNESS_REVISION
from parallax.swebench_harness import OfficialHarnessError, run_official_harness


def specs():
    return freeze_swe_specs(family())


def report(*, resolved: bool = True, missing_test: bool = False):
    task, _ = specs()
    fail_to_pass = list(task.sealed.fail_to_pass)
    if missing_test:
        fail_to_pass = []
    return {
        INSTANCE_ID: {
            "patch_exists": True,
            "patch_successfully_applied": True,
            "resolved": resolved,
            "tests_status": {
                "FAIL_TO_PASS": {"success": fail_to_pass, "failure": []},
                "PASS_TO_PASS": {
                    "success": list(task.sealed.pass_to_pass),
                    "failure": [],
                },
            },
        }
    }


def runner_for(payload, calls):
    def runner(argv: list[str], cwd: Path, timeout: int):
        calls.append(tuple(argv))
        if "swebench.harness.run_evaluation" in argv:
            target = cwd / "logs" / INSTANCE_ID
            target.mkdir(parents=True)
            (target / "report.json").write_text(json.dumps(payload), encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0, "", "")

    return runner


def test_official_harness_is_pinned_and_authoritative(tmp_path: Path) -> None:
    calls = []
    task, environment = specs()
    result = run_official_harness(
        task,
        environment,
        "diff --git a/a.py b/a.py\n",
        model="boundary-model",
        run_directory=tmp_path / "run",
        runner=runner_for(report(), calls),
    )

    assert result.outcome.verdict == Verdict.PASS
    assert result.harness_revision == SWE_BENCH_HARNESS_REVISION
    assert calls[0] == (
        "docker",
        "pull",
        f"{environment.image.ref}@sha256:{environment.image.digest}",
    )
    checkout_call = next(call for call in calls if "checkout" in call)
    assert checkout_call[-1] == SWE_BENCH_HARNESS_REVISION
    harness_call = next(call for call in calls if "--with-editable" in call)
    harness_source = harness_call[harness_call.index("--with-editable") + 1]
    assert harness_source.endswith("swebench-harness-source")
    dataset = json.loads((tmp_path / "run" / "dataset.json").read_text())
    assert dataset[0]["test_patch"] == task.sealed.test_patch


def test_official_harness_rejects_incomplete_test_coverage(tmp_path: Path) -> None:
    with pytest.raises(OfficialHarnessError, match="FAIL_TO_PASS coverage drift"):
        task, environment = specs()
        run_official_harness(
            task,
            environment,
            "diff --git a/a.py b/a.py\n",
            model="boundary-model",
            run_directory=tmp_path / "run",
            runner=runner_for(report(missing_test=True), []),
        )


def test_official_harness_classifies_empty_patch_from_summary(tmp_path: Path) -> None:
    def empty_patch_runner(argv: list[str], cwd: Path, timeout: int):
        if "swebench.harness.run_evaluation" in argv:
            summary = {
                "empty_patch_ids": [INSTANCE_ID],
                "completed_ids": [],
                "resolved_ids": [],
            }
            path = cwd / f"boundary-model.parallax-{INSTANCE_ID}.json"
            path.write_text(json.dumps(summary), encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0, "", "")

    task, environment = specs()
    result = run_official_harness(
        task,
        environment,
        "",
        model="boundary-model",
        run_directory=tmp_path / "run",
        runner=empty_patch_runner,
    )

    assert result.outcome.verdict == Verdict.WRONG
    assert result.fail_to_pass_success == ()
    assert result.pass_to_pass_success == ()


def test_official_harness_fault_is_not_a_model_verdict(tmp_path: Path) -> None:
    def failed(argv: list[str], cwd: Path, timeout: int):
        return subprocess.CompletedProcess(argv, 1, "", "docker unavailable")

    with pytest.raises(OfficialHarnessError, match="pinned image pull failed"):
        task, environment = specs()
        run_official_harness(
            task,
            environment,
            "diff --git a/a.py b/a.py\n",
            model="boundary-model",
            run_directory=tmp_path / "run",
            runner=failed,
        )


def test_official_harness_rejects_unpinned_source_checkout(tmp_path: Path) -> None:
    source = tmp_path / "harness-source"
    source.mkdir()

    def wrong_revision(argv: list[str], cwd: Path, timeout: int):
        stdout = "not-the-pinned-revision\n" if "rev-parse" in argv else ""
        return subprocess.CompletedProcess(argv, 0, stdout, "")

    with pytest.raises(OfficialHarnessError, match="source revision is not pinned"):
        task, environment = specs()
        run_official_harness(
            task,
            environment,
            "diff --git a/a.py b/a.py\n",
            model="boundary-model",
            run_directory=tmp_path / "run",
            harness_source_directory=source,
            runner=wrong_revision,
        )
