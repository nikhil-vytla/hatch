"""Sandbox containment: results, crashes, hangs, output bounds, env scrubbing."""

import os
from pathlib import Path

from strive.contracts import (
    FAILURE_CRASH,
    FAILURE_OUTPUT_LIMIT,
    FAILURE_TIMEOUT,
)
from strive.sandbox import run_strategy
from strive.tasks import SUM_INTEGERS_TASK

GOOD_STRATEGY = '''\
import re

def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"-?\\d+", input_text))
'''

CRASHING_STRATEGY = '''\
def solve(input_text: str) -> int:
    raise ValueError("boom")
'''

HANGING_STRATEGY = '''\
def solve(input_text: str) -> int:
    while True:
        pass
'''

BROKEN_AT_IMPORT_STRATEGY = "this is not python\n"

WRONG_TYPE_STRATEGY = '''\
def solve(input_text: str) -> int:
    return "not an int"  # type: ignore[return-value]
'''

FLOODING_STRATEGY = '''\
import sys

def solve(input_text: str) -> int:
    sys.stdout.write("x" * 10_000_000)
    return 0
'''

SECRET_PROBE_STRATEGY = '''\
import os

def solve(input_text: str) -> int:
    return 1 if os.environ.get("STRIVE_TEST_SECRET") else 0
'''

CWD_PROBE_STRATEGY = '''\
import os

def solve(input_text: str) -> int:
    with open("probe.txt", "w") as fh:
        fh.write("written")
    return 1 if "strive-sandbox-" in os.getcwd() else 0
'''


def _run(source: str, **kwargs: float) -> object:
    return run_strategy(
        source, SUM_INTEGERS_TASK.cases, generation_id="gen-test", **kwargs  # type: ignore[arg-type]
    )


def test_good_strategy_returns_outcomes_per_case() -> None:
    report = run_strategy(GOOD_STRATEGY, SUM_INTEGERS_TASK.cases, generation_id="g")
    assert report.ok
    assert len(report.outcomes) == len(SUM_INTEGERS_TASK.cases)
    by_id = {o.case_id: o for o in report.outcomes}
    assert by_id["negative-all"].output == -6
    assert by_id["adv-phone-like"].output == -679
    assert report.generation_id == "g"
    assert report.wall_time_s > 0


def test_raising_strategy_is_contained_per_case() -> None:
    report = run_strategy(CRASHING_STRATEGY, SUM_INTEGERS_TASK.cases, generation_id="g")
    assert report.ok  # child survives; failures are per-case data
    assert all(o.output is None and o.error is not None for o in report.outcomes)


def test_hanging_strategy_hits_hard_timeout() -> None:
    report = run_strategy(
        HANGING_STRATEGY, SUM_INTEGERS_TASK.cases, generation_id="g", timeout_s=1.0
    )
    assert not report.ok
    assert report.failure is not None and report.failure.kind == FAILURE_TIMEOUT


def test_syntax_error_reported_as_crash() -> None:
    report = run_strategy(
        BROKEN_AT_IMPORT_STRATEGY, SUM_INTEGERS_TASK.cases, generation_id="g"
    )
    assert not report.ok
    assert report.failure is not None and report.failure.kind == FAILURE_CRASH


def test_non_integer_output_flagged_as_error() -> None:
    report = run_strategy(WRONG_TYPE_STRATEGY, SUM_INTEGERS_TASK.cases, generation_id="g")
    assert report.ok
    assert all("non-integer output" in (o.error or "") for o in report.outcomes)


def test_output_flood_is_bounded_and_contained() -> None:
    report = run_strategy(
        FLOODING_STRATEGY,
        SUM_INTEGERS_TASK.cases,
        generation_id="g",
        timeout_s=10.0,
        output_bytes_cap=100_000,
    )
    assert not report.ok
    assert report.failure is not None
    assert report.failure.kind in (FAILURE_OUTPUT_LIMIT, FAILURE_CRASH)
    assert report.stdout_bytes <= 100_001


def test_no_inherited_secrets(monkeypatch: object) -> None:
    os.environ["STRIVE_TEST_SECRET"] = "s3cret"
    try:
        report = run_strategy(
            SECRET_PROBE_STRATEGY, SUM_INTEGERS_TASK.cases[:1], generation_id="g"
        )
    finally:
        del os.environ["STRIVE_TEST_SECRET"]
    assert report.ok
    assert report.outcomes[0].output == 0  # the child could not see the secret


def test_private_workspace_cwd(tmp_path: Path) -> None:
    report = run_strategy(
        CWD_PROBE_STRATEGY, SUM_INTEGERS_TASK.cases[:1], generation_id="g"
    )
    assert report.ok
    assert report.outcomes[0].output == 1  # cwd was a private sandbox workspace
    assert not (Path.cwd() / "probe.txt").exists()  # nothing written to kernel cwd
