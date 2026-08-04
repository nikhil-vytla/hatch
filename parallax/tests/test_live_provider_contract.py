from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path

import pytest
from conftest import COUNTERFACTUALS, PREDECESSOR, SOURCE_ARGUMENTS, Constructor

from parallax.evolving_intent import (
    ConstructionError,
    Message,
    build_script_family,
)
from parallax.gsm8k import Problem
from parallax.provider import (
    OpenAICompatibleProvider,
    ProviderConfig,
    ProviderRequest,
)
from parallax.runner import (
    RunIdentity,
    read_run_jsonl,
    run_experiment,
    run_script,
)
from parallax.types import SourceAnswer, SourceId

SUBMISSION_CONTRACT = "End every reply with FINAL_ANSWER: <integer>."


def problem() -> Problem:
    return Problem(
        record_id=SourceId("gsm8k-1"),
        question="Question?",
        answer=SourceAnswer("18"),
    )


class Fenced(Constructor):
    """A constructor that wraps every stage output in a Markdown fence.

    Real chat models do this constantly; the offline stubs never did, which is
    why the GSM8K construction parser shipped without fence tolerance.
    """

    def __init__(self, opening: str = "```json") -> None:
        super().__init__()
        self.opening = opening

    def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
        if messages[0].content.startswith("parallax-stage:predecessor"):
            body = json.dumps({"function": PREDECESSOR, "rationale": "earlier goal"})
        else:
            body = super().__call__(messages, budget)
        return f"{self.opening}\n{body}\n```"


@pytest.mark.parametrize("opening", ["```json", "```", "```JSON "])
def test_construction_tolerates_markdown_fences(opening: str) -> None:
    family = build_script_family(
        problem(),
        Fenced(opening),
        seed=41,
        construction_model="fenced",
    )

    assert family.source_intent.arguments[0].value == SOURCE_ARGUMENTS[0][1]
    assert all(attempt.accepted for attempt in family.attempts)


def test_fenced_construction_retains_the_raw_provider_bytes() -> None:
    family = build_script_family(
        problem(),
        Fenced(),
        seed=41,
        construction_model="fenced",
    )

    assert all(attempt.output.startswith("```json\n") for attempt in family.attempts)
    assert all(attempt.output.endswith("\n```") for attempt in family.attempts)


def test_unterminated_fence_is_still_a_construction_error() -> None:
    class Unterminated(Constructor):
        def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
            return f"```json\n{super().__call__(messages, budget)}"

    with pytest.raises(ConstructionError, match="extract-intent"):
        build_script_family(
            problem(),
            Unterminated(),
            seed=41,
            construction_model="unterminated",
        )


def test_every_stage_prompt_states_its_schema() -> None:
    constructor = Constructor()
    build_script_family(
        problem(),
        constructor,
        fallback=lambda messages, budget: json.dumps(
            {"function": PREDECESSOR, "rationale": "earlier goal"}
        ),
        seed=41,
        construction_model="offline",
        fallback_model="offline-fallback",
    )

    prompts = {
        messages[0].content.splitlines()[0]: messages[0].content
        for messages, _ in constructor.calls
    }
    assert set(prompts) == {
        "parallax-stage:extract-intent",
        "parallax-stage:counterfactual",
        "parallax-stage:predecessor",
    }
    for stage, content in prompts.items():
        assert "Schema:" in content, stage
        assert "no Markdown fence" in content or "Emit no Markdown fence" in content
    assert '"arguments"' in prompts["parallax-stage:extract-intent"]
    assert '"identifier"' in prompts["parallax-stage:counterfactual"]
    assert "successor_function" in prompts["parallax-stage:predecessor"]


def identity(arm: str = "static") -> RunIdentity:
    digest = "0" * 64
    return RunIdentity(
        design_digest=digest,
        source_id=SourceId("gsm8k-1"),
        source_digest=digest,
        model_config_digest=digest,
        trial_index=0,
        trial_seed=7,
        arm=arm,
        arm_config_digest=digest,
    )


def test_system_prompt_is_sent_and_retained(family) -> None:
    seen: list[tuple[Message, ...]] = []

    def agent(messages: tuple[Message, ...], budget: int) -> str:
        seen.append(messages)
        return "FINAL_ANSWER: 18"

    result = run_script(
        family.evolved,
        agent,
        identity("evolved"),
        agent_model="offline",
        system_prompt=SUBMISSION_CONTRACT,
    )

    assert result.transcript[0] == Message(role="system", content=SUBMISSION_CONTRACT)
    assert all(messages[0].role == "system" for messages in seen)
    assert result.usage.completed_turns == len(family.evolved.turns)


def test_absent_system_prompt_leaves_the_transcript_unchanged(family) -> None:
    result = run_script(
        family.evolved,
        lambda messages, budget: "FINAL_ANSWER: 18",
        identity("evolved"),
        agent_model="offline",
    )

    assert all(message.role != "system" for message in result.transcript)


def test_run_experiment_threads_one_system_prompt_into_every_arm(
    family,
    tmp_path: Path,
) -> None:
    output = tmp_path / "evidence.jsonl"

    run_experiment(
        (family,),
        lambda source_id, arm, seed: lambda messages, budget: "FINAL_ANSWER: 18",
        trial_seeds=(11,),
        agent_model="offline",
        model_config={"system_prompt": SUBMISSION_CONTRACT},
        threshold=0.0,
        output_path=output,
        system_prompt=SUBMISSION_CONTRACT,
    )

    runs = [record for record in read_run_jsonl(output) if record.kind == "run"]
    assert len(runs) == 3
    assert {run.arm for run in runs} == {"static", "matched", "evolved"}
    for run in runs:
        assert run.transcript[0].role == "system"
        assert run.transcript[0].content == SUBMISSION_CONTRACT


def capture(payloads: list[dict[str, object]]):
    def transport(
        endpoint: str,
        body: bytes,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> bytes:
        payloads.append(json.loads(body))
        return json.dumps(
            {
                "id": "response-1",
                "model": "boundary-model",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "ok"},
                    }
                ],
            }
        ).encode()

    return transport


def provider(payloads: list[dict[str, object]]) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        ProviderConfig(
            endpoint="https://provider.example/v1/chat/completions",
            api_key_env="PARALLAX_PROVIDER_KEY",
            model="boundary-model",
        ),
        transport=capture(payloads),
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
    )


def test_temperature_and_seed_reach_the_wire() -> None:
    payloads: list[dict[str, object]] = []

    provider(payloads).chat(temperature=1.0, seed=2026)(
        (Message(role="user", content="Solve it."),),
        64,
    )

    assert payloads[0]["temperature"] == 1.0
    assert payloads[0]["seed"] == 2026


def test_absent_seed_is_omitted_from_the_payload() -> None:
    payloads: list[dict[str, object]] = []

    provider(payloads).chat(temperature=0.7)(
        (Message(role="user", content="Solve it."),),
        64,
    )

    assert "seed" not in payloads[0]
    assert payloads[0]["temperature"] == 0.7


def test_default_chat_stays_deterministic_and_seedless() -> None:
    payloads: list[dict[str, object]] = []

    provider(payloads).chat()((Message(role="user", content="Solve it."),), 64)

    assert payloads[0]["temperature"] == 0.0
    assert "seed" not in payloads[0]


def test_provider_request_rejects_a_non_integer_seed() -> None:
    with pytest.raises(ValueError, match="seed"):
        ProviderRequest(
            model="boundary-model",
            messages=({"role": "user", "content": "Solve it."},),
            max_output_tokens=64,
            seed="2026",
        )


def test_counterfactual_stub_still_matches_source_arguments() -> None:
    assert set(COUNTERFACTUALS) == {key for key, _ in SOURCE_ARGUMENTS}
