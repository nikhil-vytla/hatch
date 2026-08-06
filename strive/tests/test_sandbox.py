"""Sandbox behavior: correct results, crash containment, hard timeout."""

from pathlib import Path

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


def _write(tmp_path: Path, source: str) -> Path:
    path = tmp_path / "strategy.py"
    path.write_text(source, encoding="utf-8")
    return path


def test_good_strategy_returns_results_per_case(tmp_path: Path) -> None:
    result = run_strategy(_write(tmp_path, GOOD_STRATEGY), SUM_INTEGERS_TASK.cases)
    assert result.ok
    assert len(result.case_results) == len(SUM_INTEGERS_TASK.cases)
    by_id = {r.case_id: r for r in result.case_results}
    assert by_id["negative-all"].output == -6
    assert by_id["no-integers"].output == 0


def test_raising_strategy_is_contained_per_case(tmp_path: Path) -> None:
    result = run_strategy(_write(tmp_path, CRASHING_STRATEGY), SUM_INTEGERS_TASK.cases)
    assert result.ok  # the child process survives; failures are per-case
    assert all(r.output is None and r.error is not None for r in result.case_results)
    assert "ValueError" in (result.case_results[0].error or "")


def test_hanging_strategy_hits_hard_timeout(tmp_path: Path) -> None:
    result = run_strategy(
        _write(tmp_path, HANGING_STRATEGY), SUM_INTEGERS_TASK.cases, timeout_s=1.0
    )
    assert not result.ok
    assert result.failure is not None and "timeout" in result.failure


def test_syntax_error_reported_as_child_failure(tmp_path: Path) -> None:
    result = run_strategy(
        _write(tmp_path, BROKEN_AT_IMPORT_STRATEGY), SUM_INTEGERS_TASK.cases
    )
    assert not result.ok
    assert result.failure is not None


def test_non_integer_output_flagged_as_error(tmp_path: Path) -> None:
    result = run_strategy(_write(tmp_path, WRONG_TYPE_STRATEGY), SUM_INTEGERS_TASK.cases)
    assert result.ok
    assert all("non-integer output" in (r.error or "") for r in result.case_results)
