"""Provisional activations: refused for executable code; mechanics preserved
for future low-risk non-code surfaces (scoped, monitored, reversible, expiring).
"""

from pathlib import Path

import pytest

from strive.contracts import (
    ACTIVATION_DURABLE,
    ACTIVATION_PROVISIONAL,
    INTERVENTION_EXPIRY_REVERT,
)
from strive.loop import promote_generation, run_cycle
from strive.propose import STRATEGY_CODE_SURFACE
from strive.store import Store, StoreError
from strive.tasks import SUM_INTEGERS_TASK

EQUIVALENT_GOOD_STRATEGY = '''\
import re

# behaviorally identical variant of the accepted fix
def solve(input_text: str) -> int:
    return sum(int(tok) for tok in re.findall(r"-?\\d+", input_text))
'''

BROKEN_STRATEGY = '''\
def solve(input_text: str) -> int:
    raise RuntimeError("provisional regression")
'''


def _prepare(tmp_path: Path, candidate_source: str) -> tuple[Store, str]:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # seed -> accepted fix (gen-0001)
    run_cycle(store, SUM_INTEGERS_TASK)  # records a 1.0-score cycle as baseline
    active = store.active_generation()
    assert active is not None
    generation = store.add_generation(
        candidate_source,
        task_fingerprint=SUM_INTEGERS_TASK.fingerprint(),
        parent_id=active.generation_id,
        origin="manual",
        surface=STRATEGY_CODE_SURFACE,
        weakness_id=None,
        decision=None,
    )
    return store, generation.generation_id


def test_provisional_activation_of_strategy_code_is_refused(tmp_path: Path) -> None:
    """Provisional safety: executable strategy-code may never take the
    low-evidence provisional path; only durable paired promotion applies."""
    store, generation_id = _prepare(tmp_path, EQUIVALENT_GOOD_STRATEGY)
    with pytest.raises(StoreError, match="not allowed for executable"):
        promote_generation(
            store,
            SUM_INTEGERS_TASK,
            generation_id,
            provisional=True,
            expires_after_cycles=2,
        )
    active = store.active_activation()
    assert active is not None and active.mode == ACTIVATION_DURABLE


def _provisional_activate(store: Store, generation_id: str, expires: int) -> None:
    """Drive the store-level provisional mechanics directly.

    The public promote path refuses provisional activation for strategy-code
    (tested above); until a low-risk non-code surface exists, the expiry/
    confirmation machinery itself is exercised at the store level so it stays
    tested for stage 3.
    """
    recent = store.cycles()
    baseline_score = recent[-1].overall_score if recent else 0.0
    store.activate(
        generation_id,
        reason="promote",
        mode=ACTIVATION_PROVISIONAL,
        expires_after_cycles=expires,
        baseline_score=baseline_score,
        policy="provisional@1",
    )


def test_provisional_mechanics_confirm_when_window_sustains_baseline(
    tmp_path: Path,
) -> None:
    store, generation_id = _prepare(tmp_path, EQUIVALENT_GOOD_STRATEGY)
    _provisional_activate(store, generation_id, expires=2)

    run_cycle(store, SUM_INTEGERS_TASK)  # window 1 (scores 1.0)
    run_cycle(store, SUM_INTEGERS_TASK)  # window 2
    run_cycle(store, SUM_INTEGERS_TASK)  # resolution happens at this cycle's start

    final = store.active_activation()
    assert final is not None
    assert final.generation_id == generation_id
    assert final.mode == ACTIVATION_DURABLE
    assert final.reason == "confirmed"


def test_provisional_mechanics_expire_and_revert_on_regression(
    tmp_path: Path,
) -> None:
    store, generation_id = _prepare(tmp_path, BROKEN_STRATEGY)
    previous_active = store.active_generation()
    assert previous_active is not None

    _provisional_activate(store, generation_id, expires=2)
    run_cycle(store, SUM_INTEGERS_TASK)  # broken generation scores 0.0
    run_cycle(store, SUM_INTEGERS_TASK)
    run_cycle(store, SUM_INTEGERS_TASK)  # resolution: revert

    final = store.active_activation()
    assert final is not None
    assert final.generation_id == previous_active.generation_id
    assert final.reason == "expired-reverted"
    # the revert is journaled as an intervention; nothing was deleted
    assert any(i.kind == INTERVENTION_EXPIRY_REVERT for i in store.interventions())
    assert generation_id in store.generations()

    # and it survives restart
    reopened = Store(store.root, SUM_INTEGERS_TASK.task_id)
    active = reopened.active_generation()
    assert active is not None and active.generation_id == previous_active.generation_id
