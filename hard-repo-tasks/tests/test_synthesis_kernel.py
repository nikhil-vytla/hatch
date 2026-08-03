from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

import parallax
import parallax.kernel as kernel
from parallax.evolving_intent import (
    CheckpointPlan,
    EvolvingIntent,
    IntentPlan,
    StaticPlan,
    replay_plan,
)
from parallax.gsm8k import Gsm8k, parse_final_answer
from parallax.kernel import (
    CheckpointSequence,
    RenderedTask,
    build_experiment,
    runtime_for,
)

FIXTURES = Path(__file__).parent / "fixtures" / "synthesis_kernel"


def _files(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    }


def test_identity_changes_cover_public_sealed_and_frozen_provenance() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    strategy = EvolvingIntent.frozen(FIXTURES / "proposal.json")
    original = parallax.build(source=source, strategy=strategy)
    public_change = parallax.build(
        source=replace(source, question=source.question + " Give one number."),
        strategy=strategy,
    )
    sealed_change = parallax.build(
        source=replace(source, answer_authority="73"),
        strategy=strategy,
    )
    proposal_change = parallax.build(
        source=source,
        strategy=replace(strategy, proposal=replace(strategy.proposal, seed=8)),
    )

    assert (
        len(
            {
                original.family_id,
                public_change.family_id,
                sealed_change.family_id,
                proposal_change.family_id,
            }
        )
        == 4
    )
    assert original.source_digest != public_change.source_digest
    assert original.verifier_digest != sealed_change.verifier_digest
    assert original.proposal_digest != proposal_change.proposal_digest


def test_family_arms_share_identity_and_have_controlled_shapes() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    family = parallax.build(
        source=source,
        strategy=EvolvingIntent.frozen(FIXTURES / "proposal.json"),
    )
    static = family.arm("static")
    matched = family.arm("matched")
    evolved = family.arm("evolved")

    assert isinstance(static.plan, StaticPlan)
    assert isinstance(matched.plan, IntentPlan)
    assert isinstance(evolved.plan, IntentPlan)
    assert [arm.arm_name for arm in family.arms] == ["static", "matched", "evolved"]
    assert len(static.plan.turns) == 1
    assert len(matched.plan.turns) == len(evolved.plan.turns) == 3
    assert matched.plan.budget == evolved.plan.budget
    assert matched.plan.events == ()
    assert {event.kind for event in evolved.plan.events} == {"reveal", "switch"}
    assert evolved.plan.turns[-1] == source.question
    assert len({arm.source.source_digest for arm in family.arms}) == 1
    assert len({arm.source.verifier_digest for arm in family.arms}) == 1
    assert len({arm.task_id for arm in family.arms}) == 3
    assert {check.name for check in family.certificate.checks} == {
        "source_verifier_parity",
        "terminal_anchor_replay",
        "matched_evolved_budget",
        "public_leakage",
        "oracle_success",
        "wrong_answer_failure",
        "deterministic_locked_rebuild",
    }
    assert family.certificate.policy_revision == "gsm8k-family-admission.v1"


def test_admission_detects_non_deterministic_rebuild(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    strategy = EvolvingIntent.frozen(FIXTURES / "proposal.json")
    compile_plans = kernel.compile_plans
    calls = 0

    def unstable_compile(source_task, evolving_strategy):
        nonlocal calls
        calls += 1
        plans = compile_plans(source_task, evolving_strategy)
        if calls == 2:
            static, matched, evolved = plans
            assert isinstance(static, StaticPlan)
            static = replace(
                static,
                budget=replace(
                    static.budget,
                    output_tokens_per_turn=static.budget.output_tokens_per_turn + 1,
                ),
            )
            return static, matched, evolved
        return plans

    monkeypatch.setattr(kernel, "compile_plans", unstable_compile)

    with pytest.raises(kernel.AdmissionError, match="deterministic_locked_rebuild"):
        parallax.build(source=source, strategy=strategy)


def test_public_payload_does_not_contain_sealed_authority_or_future_turns() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    family = parallax.build(
        source=source,
        strategy=EvolvingIntent.frozen(FIXTURES / "proposal.json"),
    )
    for arm in family.arms:
        public = json.dumps(arm.public_payload(), sort_keys=True)
        assert "answer_authority" not in public
        assert "scheduled_turns" not in public
        assert "proposal" not in public
        for future in arm.plan.turns[1:]:
            if future != arm.plan.turns[0]:
                assert future not in public
        sealed = json.dumps(arm.sealed_payload(), sort_keys=True)
        assert '"answer_authority": "72"' in sealed


def test_tampered_terminal_anchor_fails_replay_and_rendering() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    strategy = EvolvingIntent.frozen(FIXTURES / "proposal.json")
    family = parallax.build(source=source, strategy=strategy)
    evolved = family.arm("evolved")
    assert isinstance(evolved.plan, IntentPlan)
    tampered = replace(
        evolved.plan,
        turns=(*evolved.plan.turns[:-1], "A regenerated terminal request."),
    )

    with pytest.raises(ValueError, match="source-copied anchor"):
        replay_plan(source, tampered)
    with pytest.raises(ValueError, match="source-copied anchor"):
        RenderedTask(source, strategy.proposal, tampered)


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        ("reasoning\n#### 1,200", "1200"),
        ("The final answer is -3.50.", "-3.5"),
        (r"Therefore \boxed{72}", "72"),
        ("```answer\n1/2\n```", "1/2"),
        ("work 4 then 8 then 12", "12"),
    ],
)
def test_gsm8k_final_answer_parsing(response: str, expected: str) -> None:
    assert parse_final_answer(response) == expected


def test_native_gsm8k_evaluator_accepts_oracle_and_rejects_wrong_answer() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    assert source.answer_authority == "72"
    assert source.score("Natalia sold 72. #### 72")
    assert source.score(r"Final answer: \boxed{72}")
    assert not source.score("#### 71")


def test_conversation_run_executes_sync_and_async_callbacks() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    family = parallax.build(
        source=source,
        strategy=EvolvingIntent.frozen(FIXTURES / "proposal.json"),
    )
    seen: list[int] = []

    def sync_agent(messages: tuple[object, ...]) -> str:
        seen.append(len(messages))
        return "#### 72" if len(seen) == 3 else "Acknowledged."

    sync_verdict = asyncio.run(parallax.run(family.arm("evolved"), agent=sync_agent))
    assert sync_verdict.reward == 1.0
    assert sync_verdict.turns_completed == 3
    assert seen == [1, 3, 5]

    async def async_agent(messages: tuple[object, ...]) -> str:
        return "#### 72"

    async_verdict = asyncio.run(parallax.run(family.arm("static"), agent=async_agent))
    assert async_verdict.reward == 1.0


def test_checkpoint_runtime_is_a_placeholder_only() -> None:
    source = Gsm8k.load(FIXTURES / "gsm8k.json")
    strategy = EvolvingIntent.frozen(FIXTURES / "proposal.json")
    task = RenderedTask(
        source,
        strategy.proposal,
        CheckpointPlan(("checkpoint-1",)),
    )
    assert isinstance(runtime_for(task), CheckpointSequence)
    with pytest.raises(NotImplementedError):
        asyncio.run(parallax.run(runtime_for(task), agent=lambda _: "#### 72"))


def test_locked_replay_is_network_free_and_byte_identical(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_root = tmp_path / "config"
    shutil.copytree(FIXTURES, config_root)
    first_store = tmp_path / "first"
    first = build_experiment(
        experiment=config_root / "experiment.toml",
        store=first_store,
    )
    first_files = _files(first_store / first.family_id)
    (config_root / "experiment.toml").write_text("this is no longer valid TOML")

    def fail_network(*args: object, **kwargs: object) -> object:
        raise AssertionError("locked replay attempted network access")

    monkeypatch.setattr(socket, "socket", fail_network)
    second_store = tmp_path / "second"
    second = build_experiment(
        locked=config_root / "family.lock",
        store=second_store,
    )

    assert first.family_id == second.family_id
    assert first_files == _files(second_store / second.family_id)


def test_cli_build_reruns_idempotently_and_replays_lock(tmp_path: Path) -> None:
    config_root = tmp_path / "config"
    shutil.copytree(FIXTURES, config_root)
    store = tmp_path / "artifacts"
    environment = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
    command = [
        sys.executable,
        "-m",
        "parallax.cli",
        "build",
        str(config_root / "experiment.toml"),
        "--store",
        str(store),
    ]
    first = subprocess.run(command, check=True, capture_output=True, text=True, env=environment)
    first_id = json.loads(first.stdout)["family_id"]
    before = _files(store / first_id)
    subprocess.run(command, check=True, capture_output=True, text=True, env=environment)
    assert before == _files(store / first_id)

    replay_store = tmp_path / "replay"
    replay = subprocess.run(
        [
            sys.executable,
            "-m",
            "parallax.cli",
            "build",
            "--locked",
            str(config_root / "family.lock"),
            "--store",
            str(replay_store),
        ],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    assert json.loads(replay.stdout)["family_id"] == first_id
    assert before == _files(replay_store / first_id)
