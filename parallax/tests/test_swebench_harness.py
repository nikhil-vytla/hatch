from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, row, runtime

from parallax.outcome import Verdict
from parallax.swebench import (
    SWE_BENCH_HARNESS_REVISION,
    load_swebench_rows,
)
from parallax.swebench_harness import OfficialHarnessError, run_official_harness


def problem():
    return load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]


def report(*, resolved: bool = True, missing_test: bool = False):
    selected = problem()
    fail_to_pass = list(selected.verifier.fail_to_pass)
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
                    "success": list(selected.verifier.pass_to_pass),
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
    selected = problem()
    result = run_official_harness(
        selected,
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
        f"{selected.verifier.image_ref}@sha256:{selected.verifier.image_digest}",
    )
    harness_call = next(call for call in calls if "--with" in call)
    assert SWE_BENCH_HARNESS_REVISION in harness_call[harness_call.index("--with") + 1]
    dataset = json.loads((tmp_path / "run" / "dataset.json").read_text())
    assert dataset[0]["test_patch"] == selected.verifier.test_patch


def test_official_harness_rejects_incomplete_test_coverage(tmp_path: Path) -> None:
    with pytest.raises(OfficialHarnessError, match="FAIL_TO_PASS coverage drift"):
        run_official_harness(
            problem(),
            "diff --git a/a.py b/a.py\n",
            model="boundary-model",
            run_directory=tmp_path / "run",
            runner=runner_for(report(missing_test=True), []),
        )


def test_official_harness_fault_is_not_a_model_verdict(tmp_path: Path) -> None:
    def failed(argv: list[str], cwd: Path, timeout: int):
        return subprocess.CompletedProcess(argv, 1, "", "docker unavailable")

    with pytest.raises(OfficialHarnessError, match="pinned image pull failed"):
        run_official_harness(
            problem(),
            "diff --git a/a.py b/a.py\n",
            model="boundary-model",
            run_directory=tmp_path / "run",
            runner=failed,
        )
