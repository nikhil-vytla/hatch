from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from parallax.autoresearch import (
    CampaignManifest,
    IntentCondition,
    RunRecord,
    RunStatus,
    append_record,
    default_tasks,
    extract_integer,
    load_records,
    render_conversation,
    summarize_records,
    verify_response,
)


def _record(
    task_id: str,
    condition: str,
    repetition: int,
    *,
    reward: float | None,
    status: RunStatus,
) -> RunRecord:
    return RunRecord(
        campaign_id="test",
        campaign_digest="campaign",
        task_id=task_id,
        source_digest="source",
        conversation_digest=f"{condition}-{task_id}",
        condition=condition,
        model="model",
        repetition=repetition,
        calls=4,
        expected=42,
        parsed_answer=42 if reward == 1.0 else None,
        reward=reward,
        status=status,
        final_response="42" if reward == 1.0 else "",
        replies=(),
        trace_ids=(),
        started_at="start",
        finished_at="finish",
    )


def test_all_conditions_preserve_the_source_verifier_target() -> None:
    task = default_tasks()[0]
    for condition in IntentCondition:
        variant = render_conversation(task, condition)
        assert variant.expected == task.expected
        expected_calls = 1 if condition == IntentCondition.STATIC else 4
        assert len(variant.turns) == expected_calls


def test_revision_and_combined_restore_the_anchor_rate() -> None:
    task = default_tasks()[0]
    wrong_rate = task.points_per_unit + 3
    for condition in (IntentCondition.REVISION, IntentCondition.COMBINED):
        variant = render_conversation(task, condition)
        transcript = "\n".join(variant.turns)
        assert str(wrong_rate) in transcript
        assert f"not {wrong_rate}" in transcript
        assert str(task.points_per_unit) in transcript


def test_intent_ledger_is_one_declared_intervention() -> None:
    task = default_tasks()[0]
    base = render_conversation(task, IntentCondition.COMBINED)
    ledger = render_conversation(task, IntentCondition.COMBINED, intent_ledger=True)
    assert ledger.parent_condition == base.condition
    assert ledger.intervention == "canonical-active-intent-ledger-v1"
    assert ledger.turns[:-1] == base.turns[:-1]
    assert "Current intent ledger" in ledger.turns[-1]
    assert ledger.expected == base.expected


def test_integer_verifier_accepts_common_formats() -> None:
    assert extract_integer("The answer is 1,234.") == 1234
    assert extract_integer(r"Therefore \boxed{-37}") == -37
    assert verify_response("final: 42", 42) == (42, 1.0)
    assert verify_response("no numeric answer", 42) == (None, 0.0)


def test_record_roundtrip_is_append_only(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    first = _record("a", "repeat", 0, reward=1.0, status=RunStatus.SUCCESS)
    second = _record("a", "revision", 0, reward=0.0, status=RunStatus.MODEL_FAILURE)
    append_record(path, first)
    append_record(path, second)
    assert load_records(path) == [first, second]


def test_summary_separates_provider_errors_and_pairs_by_source() -> None:
    records = [
        _record("a", "repeat", 0, reward=1.0, status=RunStatus.SUCCESS),
        _record("a", "revision", 0, reward=0.0, status=RunStatus.MODEL_FAILURE),
        _record("b", "repeat", 0, reward=1.0, status=RunStatus.SUCCESS),
        _record("b", "revision", 0, reward=None, status=RunStatus.PROVIDER_ERROR),
    ]
    summary = summarize_records(records)
    revision = summary["conditions"]["revision"]
    assert revision["valid_runs"] == 1
    assert revision["provider_errors"] == 1
    assert summary["paired_against_repeat"]["revision"] == {
        "pairs": 1,
        "mean_delta_vs_repeat": -1.0,
        "degraded_pairs": 1,
        "improved_pairs": 0,
    }


def test_campaign_digest_changes_with_protocol() -> None:
    campaign = CampaignManifest(
        campaign_id="test",
        model="model",
        repetitions=2,
        tasks=default_tasks(),
        conditions=tuple(IntentCondition),
    )
    changed = replace(campaign, model="other-model")
    assert campaign.digest() != changed.digest()
