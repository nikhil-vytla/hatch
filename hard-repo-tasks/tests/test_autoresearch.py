from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from parallax.autoresearch import (
    CampaignManifest,
    IntentCondition,
    LookupRecord,
    LookupTask,
    RunRecord,
    RunStatus,
    append_record,
    default_tasks,
    extract_integer,
    generate_lookup_tasks,
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
    buried = {
        IntentCondition.REPEAT_BURIED,
        IntentCondition.COMBINED_BURIED,
        IntentCondition.REPEAT_TABLELAST,
        IntentCondition.COMBINED_TABLELAST,
    }
    for condition in IntentCondition:
        if condition in buried:
            with pytest.raises(ValueError, match="unsupported condition"):
                render_conversation(task, condition)
            continue
        variant = render_conversation(task, condition)
        assert variant.expected == task.expected
        if condition == IntentCondition.STATIC:
            expected_calls = 1
        elif condition in {
            IntentCondition.REPEAT_DEEP,
            IntentCondition.COMBINED_DEEP,
        }:
            expected_calls = 7
        else:
            expected_calls = 4
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


def test_deep_combined_restores_every_superseded_value() -> None:
    task = default_tasks()[0]
    variant = render_conversation(task, IntentCondition.COMBINED_DEEP)
    transcript = "\n".join(variant.turns)
    assert f"not {task.teams + 2}" in transcript
    assert f"not {task.units_per_team - 3}" in transcript
    assert f"not {task.points_per_unit + 4}" in transcript
    assert f"not {task.penalty + 18}" in transcript


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


def test_lookup_task_is_static_solvable_and_anchor_preserving() -> None:
    task = LookupTask(
        task_id="routing",
        records=(
            LookupRecord("north", "standard", "email", "AMBER"),
            LookupRecord("south", "priority", "chat", "BIRCH"),
            LookupRecord("east", "priority", "chat", "RAVEN"),
        ),
        anchor_region="east",
        anchor_tier="priority",
        anchor_channel="chat",
    )
    static = render_conversation(task, IntentCondition.STATIC)
    combined = render_conversation(task, IntentCondition.COMBINED_DEEP)
    ledger = render_conversation(
        task,
        IntentCondition.COMBINED_DEEP,
        intent_ledger=True,
    )
    assert task.expected == "RAVEN"
    assert static.expected == combined.expected == ledger.expected
    assert len(static.turns) == 1
    assert len(combined.turns) == len(ledger.turns) == 7
    assert "Current intent ledger" in ledger.turns[-1]
    assert verify_response("The routing code is RAVEN.", "RAVEN") == ("RAVEN", 1.0)


def test_buried_lookup_conditions_hide_the_anchor_after_the_burial_point() -> None:
    tasks = generate_lookup_tasks(count=12, rows_per_task=24, seed=42)
    for task in tasks:
        anchor_values = (task.anchor_region, task.anchor_tier, task.anchor_channel)
        repeat = render_conversation(task, IntentCondition.REPEAT_BURIED)
        combined = render_conversation(task, IntentCondition.COMBINED_BURIED)
        assert repeat.expected == combined.expected == task.expected
        assert len(repeat.turns) == len(combined.turns) == 12
        # The matched control names the anchor only in its opening prompt.
        for turn in repeat.turns[1:]:
            assert not any(value in turn for value in anchor_values)
        # The evolving arm finishes every correction by turn five; nothing
        # after the burial point restates an anchor field or the answer.
        for value in anchor_values:
            assert any(value in turn for turn in combined.turns[:5])
        for turn in combined.turns[5:]:
            assert not any(value in turn for value in anchor_values)
            assert task.expected not in turn


def test_buried_lookup_side_questions_share_no_field_with_the_anchor() -> None:
    task = generate_lookup_tasks(count=12, rows_per_task=24, seed=42)[0]
    by_triple = {
        (record.region, record.tier, record.channel): record
        for record in task.records
    }
    combined = render_conversation(task, IntentCondition.COMBINED_BURIED)
    side_turns = [turn for turn in combined.turns if turn.startswith("Side question")]
    assert len(side_turns) == 4
    for turn in side_turns:
        matches = [
            record
            for triple, record in by_triple.items()
            if all(part in turn for part in triple)
        ]
        assert len(matches) == 1
        record = matches[0]
        assert record.region != task.anchor_region
        assert record.tier != task.anchor_tier
        assert record.channel != task.anchor_channel
        assert record.code != task.expected


def test_tablelast_lookup_conditions_withhold_every_code_until_the_end() -> None:
    tasks = generate_lookup_tasks(count=12, rows_per_task=24, seed=42)
    for task in tasks:
        anchor_values = (task.anchor_region, task.anchor_tier, task.anchor_channel)
        repeat = render_conversation(task, IntentCondition.REPEAT_TABLELAST)
        combined = render_conversation(task, IntentCondition.COMBINED_TABLELAST)
        assert repeat.expected == combined.expected == task.expected
        assert len(repeat.turns) == len(combined.turns) == 12
        for variant in (repeat, combined):
            # No routing code exists anywhere before the final turn, so the
            # model cannot resolve the answer early and copy it forward.
            for turn in variant.turns[:-1]:
                assert "CODE" not in turn
                assert "Routing table" not in turn
            assert "Routing table" in variant.turns[-1]
            assert task.expected in variant.turns[-1]
        # The evolving arm fixes the anchor by turn five and never restates
        # it until the table arrives.
        for value in anchor_values:
            assert any(value in turn for turn in combined.turns[:5])
        for turn in combined.turns[5:-1]:
            assert not any(value in turn for value in anchor_values)
        # The matched control names the anchor only in its opening turn.
        for turn in repeat.turns[1:-1]:
            assert not any(value in turn for value in anchor_values)


def test_lookup_task_generator_is_deterministic_and_dense() -> None:
    first = generate_lookup_tasks(count=4, rows_per_task=18, seed=42)
    second = generate_lookup_tasks(count=4, rows_per_task=18, seed=42)
    assert first == second
    assert len({task.digest() for task in first}) == 4
    assert all(len(task.records) == 18 for task in first)
    assert all(task.expected.startswith("CODE") for task in first)
