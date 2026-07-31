from __future__ import annotations

from dataclasses import replace

import pytest

from parallax.variants import (
    AnchorTrajectory,
    Budget,
    IntentAnchor,
    IntentEvent,
    IntentEventKind,
    IntentRelation,
    IntentSlot,
    StateMode,
    TaskComponent,
    TaskSpec,
    TaskVariant,
    VerifierPolicy,
    admit_variant,
    compile_anchor_trajectory,
    default_variant_blueprints,
)


def _source() -> TaskSpec:
    return TaskSpec(
        task_id="duration-parser",
        instruction="Support decimal hours without changing the public API.",
        initial_state_id="repo@abc123",
        goals=("Parse decimal hour durations.",),
        constraints=("Keep the public API stable.", "Add no dependencies."),
        verifier_id="verifier@def456",
        budget=Budget(max_turns=1, max_tool_calls=100, timeout_seconds=900),
        metadata=(("repository", "example/parser"),),
    )


def test_blueprints_cover_ten_distinct_causal_families() -> None:
    blueprints = default_variant_blueprints()
    assert len(blueprints) == 10
    assert len({blueprint.family for blueprint in blueprints}) == 10
    assert any(blueprint.state_mode == StateMode.STAGED for blueprint in blueprints)
    assert any(blueprint.verifier_policy == VerifierPolicy.REPLACE for blueprint in blueprints)
    assert not any(blueprint.independent_benchmark_task for blueprint in blueprints)


def test_anchor_trajectory_restores_goal_and_revised_constraints() -> None:
    anchor = IntentAnchor(
        goal="Fix decimal duration parsing.",
        slots=(
            IntentSlot("constraint:0", "Keep the public API stable."),
            IntentSlot("constraint:1", "Add no dependencies."),
        ),
    )
    trajectory = AnchorTrajectory(
        initial_goal="Map the parser architecture.",
        initial_values=(("constraint:0", "Rename the public API."),),
        initially_revealed=("constraint:0",),
        events=(
            IntentEvent(
                turn=2,
                kind=IntentEventKind.REVEAL,
                target="constraint:1",
                before=None,
                after="Add no dependencies.",
                message="Also, do not add a dependency.",
            ),
            IntentEvent(
                turn=3,
                kind=IntentEventKind.REVISE,
                target="constraint:0",
                before="Rename the public API.",
                after="Keep the public API stable.",
                message="Correction: preserve the public API.",
            ),
            IntentEvent(
                turn=4,
                kind=IntentEventKind.SWITCH,
                target="goal",
                before="Map the parser architecture.",
                after="Fix decimal duration parsing.",
                message="Now implement decimal duration support.",
            ),
        ),
    )
    compiled = compile_anchor_trajectory(anchor, trajectory)
    assert compiled.final_goal == anchor.goal
    assert dict(compiled.final_values) == anchor.values()
    assert len(compiled.turns) == 3


def test_anchor_trajectory_rejects_a_stale_terminal_intent() -> None:
    anchor = IntentAnchor(
        goal="Fix decimal duration parsing.",
        slots=(IntentSlot("constraint:0", "Keep the public API stable."),),
    )
    trajectory = AnchorTrajectory(
        initial_goal=anchor.goal,
        initial_values=(("constraint:0", "Rename the public API."),),
        initially_revealed=("constraint:0",),
        events=(),
    )
    with pytest.raises(ValueError, match="do not return to the anchor"):
        compile_anchor_trajectory(anchor, trajectory)


def test_instruction_variant_reuses_verifier_but_remains_clustered() -> None:
    source = _source()
    candidate = replace(
        source,
        task_id="duration-parser.paraphrase",
        instruction="Parse fractional hours and preserve the existing API.",
    )
    variant = TaskVariant(
        source_task_id=source.task_id,
        variant_id=candidate.task_id,
        source_digest=source.digest(),
        spec=candidate,
        declared_components=(TaskComponent.INSTRUCTION,),
        relation=IntentRelation.PRESERVE,
        state_mode=StateMode.TRANSACTIONAL,
        verifier_policy=VerifierPolicy.REUSE,
        generator_version="test",
    )
    admission = admit_variant(source, variant)
    assert admission.admitted
    assert admission.clustered_with_source


def test_behavior_change_requires_a_transformed_verifier() -> None:
    source = _source()
    candidate = replace(
        source,
        task_id="duration-parser.extension",
        goals=("Parse decimal hours and reject non-finite values.",),
    )
    variant = TaskVariant(
        source_task_id=source.task_id,
        variant_id=candidate.task_id,
        source_digest=source.digest(),
        spec=candidate,
        declared_components=(TaskComponent.GOAL,),
        relation=IntentRelation.REFINE,
        state_mode=StateMode.TRANSACTIONAL,
        verifier_policy=VerifierPolicy.REUSE,
        generator_version="test",
    )
    admission = admit_variant(source, variant)
    assert not admission.admitted
    assert "original verifier cannot be reused" in " ".join(admission.violations)
