"""The committed spend ledger must keep matching the committed evidence.

A stale pricing constant made several published cost figures wrong, and one of
them nearly became a findings-table headline. The audit script re-derives every
figure from retained tokens; this test makes a drifted ledger fail offline
rather than surface in a document.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

RESEARCH = Path(__file__).parents[1] / "research"
AUDIT = RESEARCH / "spend-audit-20260803" / "audit_spend.py"
LEDGER = RESEARCH / "spend-audit-20260803" / "spend-ledger.json"
ROUND2_REPORT = RESEARCH / "swebench-screening-round2-20260803" / "round2-report.json"
CROSS_SESSION = (
    RESEARCH
    / "swebench-single-vs-evolved-20260803"
    / "evidence"
    / "cross-session-spend.json"
)


def _audit() -> dict[str, object]:
    spec = importlib.util.spec_from_file_location("audit_spend", AUDIT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Dataclasses resolve their annotations through sys.modules.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        return module.audit()
    finally:
        del sys.modules[spec.name]


@pytest.fixture(scope="module")
def audited() -> dict[str, object]:
    return _audit()


def _run(audited: dict[str, object], folder: str) -> dict[str, object]:
    runs = audited["runs"]
    assert isinstance(runs, dict)
    run = runs[folder]
    assert isinstance(run, dict)
    return run


def test_the_committed_ledger_still_reproduces(audited: dict[str, object]) -> None:
    assert audited == json.loads(LEDGER.read_text())


def test_round_two_matches_its_own_canonical_cost_receipt(
    audited: dict[str, object],
) -> None:
    report = json.loads(ROUND2_REPORT.read_text())
    run = _run(audited, "swebench-screening-round2-20260803")

    assert run["token_derived_metered_usd"] == pytest.approx(
        report["actual_metered_cost_usd"]
    )
    assert run["receipt_sum_as_written_usd"] > 2 * float(
        report["actual_metered_cost_usd"]
    )


def test_the_experiment_total_agrees_with_its_session_attribution(
    audited: dict[str, object],
) -> None:
    """Two independent routes to the same number: tokens, and paying session."""
    cross_session = json.loads(CROSS_SESSION.read_text())
    run = _run(audited, "swebench-single-vs-evolved-20260803")

    assert run["token_derived_metered_usd"] == pytest.approx(
        cross_session["unique_metered_total_usd"]
    )


def test_receipt_sums_are_never_quoted_as_the_authoritative_figure(
    audited: dict[str, object],
) -> None:
    runs = audited["runs"]
    assert isinstance(runs, dict)
    for folder, run in runs.items():
        assert isinstance(run, dict)
        assert run["token_derived_metered_usd"] <= run["receipt_sum_as_written_usd"], (
            f"{folder}: re-metering must never exceed the receipts it corrects"
        )
