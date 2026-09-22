import asyncio
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from pydantic import BaseModel, Field

from jev_lab.core import BudgetExceeded, CapacityBusy, Client, Ledger, Run, choice, normalize, noul
from jev_lab.metrics import classification
from jev_lab.semantic import Ticket, decode, questions_for
from jev_lab.teach import optimize_policy


def test_game_publication_preserves_observations_and_errors():
    import copy

    from jev_lab.reporting import compact_game_states

    original = {
        "episodes": [
            {
                "trace": [
                    {"state": {"visible_grid": [["goal"]]}, "action": "forward"},
                    {"state": {"visible_grid": [["goal"]]}, "action": "turn_left"},
                    {"error": "unavailable"},
                ]
            }
        ]
    }
    compact = compact_game_states(copy.deepcopy(original))
    assert len(compact["observations"]) == 1
    for frame in compact["episodes"][0]["trace"]:
        if "state_id" in frame:
            frame["state"] = compact["observations"][frame.pop("state_id")]
    assert compact["episodes"] == original["episodes"]


@pytest.mark.asyncio
async def test_game_cache_reuses_exact_observations_without_changing_actions():
    from jev_lab.games import episode

    class ClientFixture:
        calls = 0

        async def evaluate(self, state, questions, tag):
            self.calls += 1
            return {
                "answers": {"action": {"value": "turn_left", "confidence": 1}},
                "latency_ms": 10,
            }

    client, memo = ClientFixture(), {}
    first = await episode(
        client, "MiniGrid-Empty-5x5-v0", 0, "jev_reactive", max_steps=12, memo=memo
    )
    calls = client.calls
    second = await episode(
        client, "MiniGrid-Empty-5x5-v0", 0, "jev_reactive", max_steps=12, memo=memo
    )
    assert 0 < calls < 12
    assert client.calls == calls
    assert [r["action"] for r in first["trace"]] == [r["action"] for r in second["trace"]]
    assert all(r["cache_hit"] and r["latency_ms"] == 0 for r in second["trace"])


def test_atomic_budget_and_unknown_cost(tmp_path):
    ledger = Ledger(tmp_path / "budget.sqlite", dollars=0.006, calls=100)

    def reserve(_):
        try:
            return ledger.reserve("test", "model", 0.002)
        except (BudgetExceeded, CapacityBusy):
            return None

    with ThreadPoolExecutor(max_workers=12) as pool:
        ids = [x for x in pool.map(reserve, range(12)) if x is not None]
    assert len(ids) == 3
    assert ledger.summary()["accounted_usd"] == pytest.approx(0.006)
    ledger.settle(ids[0], 0, "ok")
    ledger.settle(ids[1], None, "error")
    assert ledger.summary()["models"][0]["unknown_cost_attempts"] == 2
    assert ledger.summary()["accounted_usd"] == pytest.approx(0.004)


def test_provider_contract_rejects_missing_and_malformed_answers():
    questions = {"intent": choice("Which?", ["a", "b"])}
    for raw in [
        {"answers": {}},
        {"answers": {"intent": {"type": "choice", "choice": "c"}}},
        {"answers": {"intent": {"type": "choice", "choice": "a", "probabilities": {"a": 1}}}},
        {"answers": {"intent": {"type": "score", "score": 0}}},
    ]:
        with pytest.raises(ValueError):
            normalize(raw, questions)


def test_noul_boundaries_and_pydantic_validation():
    for value in (-0.1, 1.1, float("nan")):
        with pytest.raises(ValueError):
            normalize({"answers": {"x": {"type": "noul", "noul": value}}}, {"x": noul("True?")})
    answers = {
        "area": {"type": "choice", "value": "billing", "probabilities": {
            "billing": 1.0, "technical": 0.0, "account": 0.0, "other": 0.0,
        }},
        "refund": {"type": "noul", "value": 0.5},
        "missing_context": {"type": "noul", "value": 0.2},
    }
    assert decode(Ticket, answers).refund is True
    with pytest.raises(ValueError):
        decode(Ticket, {**answers, "refund": {"type": "noul", "value": 9}})

    class FreeText(BaseModel):
        text: str = Field(description="Extract arbitrary text")

    with pytest.raises(ValueError):
        questions_for(FreeText)

    class OptionalField(BaseModel):
        flag: bool = Field(default=False, description="True?")

    with pytest.raises(ValueError):
        questions_for(OptionalField)


@pytest.mark.asyncio
async def test_http_error_is_recorded_and_cancellation_releases_reservation(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-secret-never-print")
    ledger = Ledger(tmp_path / "ledger.sqlite")
    run = Run("test", path=tmp_path / "run")
    client = Client(run, ledger)
    await client.http.aclose()

    async def fail(request):
        return httpx.Response(403, json={"message": "no access"})

    client.http = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    with pytest.raises(RuntimeError, match="HTTP 403"):
        await client.evaluate("fixture", {"x": noul("True?")})
    assert "test-secret" not in (run.path / "requests.jsonl").read_text()
    assert ledger.summary()["attempts"] == 1
    await client.http.aclose()
    entered = asyncio.Event()

    async def wait(request):
        entered.set()
        await asyncio.Event().wait()

    client.http = httpx.AsyncClient(transport=httpx.MockTransport(wait))
    task = asyncio.create_task(client.evaluate("fixture", {"x": noul("True?")}))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    with ledger.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM spend WHERE status='pending'").fetchone()[0] == 0
    await client.close()


def test_failed_cases_remain_in_accuracy_denominator():
    metrics = classification([{"target": "a", "prediction": "a"}, {"error": "429"}])
    assert metrics["accuracy_all_attempted"] == 0.5
    assert metrics["accuracy_answered"] == 1


def test_reward_training_changes_policy_and_improves_independent_behavior():
    import numpy as np

    x = np.eye(3)
    weights, curve = optimize_policy(x, np.eye(3), x, np.array([0, 1, 2]), steps=80)
    assert np.count_nonzero(weights) > 0
    assert curve[-1]["oracle_test_accuracy"] == 1
    assert curve[-1]["mean_teacher_reward"] > curve[0]["mean_teacher_reward"]


def test_question_branches_cannot_read_each_other():
    pytest.importorskip("torch")
    from jev_lab.replica import branch_mask

    mask = branch_mask([0, 0, 1, 1, 2, 2], "cpu")[0, 0]
    assert mask[5, 0] == 0 and mask[5, 1] == 0
    assert mask[5, 2] < -1e30 and mask[5, 3] < -1e30
    assert mask[5, 4] == 0 and mask[5, 5] == 0
    assert mask[2, 3] < -1e30
