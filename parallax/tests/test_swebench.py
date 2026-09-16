from __future__ import annotations

import json

import pytest

from parallax.intent_phases import (
    BASE,
    EVOLVED,
    MATCHED,
    PhaseArgument,
    PhaseConstruction,
    PhaseIntent,
    build_phase_variants,
    construct_phases,
)
from parallax.provider import Message
from parallax.swebench import (
    PUBLISHED_INSTANCE_IDS,
    SWE_BENCH_REVISION,
    ImageDigest,
    SweBenchError,
    VerifierRuntime,
    fetch_swebench_verified,
    load_swebench_rows,
)

INSTANCE_ID = "astropy__astropy-13236"


def test_published_source_set_is_exact_and_screening_is_a_subset() -> None:
    assert len(PUBLISHED_INSTANCE_IDS) == 50
    assert len(set(PUBLISHED_INSTANCE_IDS)) == 50


def row() -> dict[str, object]:
    return {
        "repo": "astropy/astropy",
        "instance_id": INSTANCE_ID,
        "base_commit": "6ed769d58d89380ebaa1ef52b300691eefda8928",
        "patch": "gold solution must be discarded",
        "test_patch": "sealed test patch",
        "problem_statement": (
            "Structured ndarray columns should remain Columns instead of being "
            "automatically converted to NdarrayMixin."
        ),
        "hints_text": "",
        "created_at": "2022-05-09T14:16:30Z",
        "version": "5.0",
        "FAIL_TO_PASS": json.dumps(
            ["astropy/table/tests/test_mixin.py::test_ndarray_mixin[False]"]
        ),
        "PASS_TO_PASS": json.dumps(
            ["astropy/table/tests/test_mixin.py::test_ndarray_mixin[True]"]
        ),
        "environment_setup_commit": "cdf311e0714e611d48b0a31eb1f0e2cbffab7f23",
        "difficulty": "15 min - 1 hour",
    }


def runtime() -> VerifierRuntime:
    return VerifierRuntime(image_digest=ImageDigest("a" * 64))


def construction() -> PhaseConstruction:
    return PhaseConstruction(
        source=PhaseIntent(
            function="preserve structured ndarray columns",
            arguments=(
                PhaseArgument(
                    identifier="observed_symptom",
                    value="structured arrays become NdarrayMixin",
                    category="symptom",
                ),
                PhaseArgument(
                    identifier="required_behavior",
                    value="construct a regular Column",
                    category="constraint",
                ),
            ),
        ),
        predecessors=(
            PhaseIntent(
                function="inspect table column conversion",
                arguments=(
                    PhaseArgument(
                        identifier="current_symptom",
                        value="automatic mixin conversion occurs",
                        category="symptom",
                    ),
                    PhaseArgument(
                        identifier="target_module",
                        value="astropy.table.table",
                        category="context",
                    ),
                ),
            ),
        ),
    )


def test_loader_separates_public_source_from_sealed_verifier() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]

    assert problem.instance_id == INSTANCE_ID
    assert problem.verifier.fail_to_pass == (
        "astropy/table/tests/test_mixin.py::test_ndarray_mixin[False]",
    )
    assert problem.verifier.image_ref.endswith("astropy_1776_astropy-13236")
    assert "patch" not in type(problem).model_fields
    assert "sealed test patch" not in problem.problem_statement
    assert problem.verifier.gold_patch == "gold solution must be discarded"
    assert "gold solution" not in problem.model_dump_json(exclude={"verifier"})


def test_loader_rejects_unknown_ids_and_structural_drift() -> None:
    with pytest.raises(SweBenchError, match="published set"):
        load_swebench_rows(
            (row(),),
            ("not-published",),
            runtimes={"not-published": runtime()},
        )
    invalid = {**row(), "extra": True}
    with pytest.raises(SweBenchError, match="Extra inputs"):
        load_swebench_rows(
            (invalid,),
            (INSTANCE_ID,),
            runtimes={INSTANCE_ID: runtime()},
        )


def test_fetch_checks_revision_before_and_after_rows() -> None:
    calls = 0

    def fetch(url: str) -> bytes:
        nonlocal calls
        calls += 1
        if "datasets-server" not in url:
            return json.dumps({"sha": SWE_BENCH_REVISION}).encode()
        assert f"revision={SWE_BENCH_REVISION}" in url
        return json.dumps(
            {
                "features": [
                    {
                        "feature_idx": 0,
                        "name": "repo",
                        "type": {"dtype": "string", "_type": "Value"},
                    }
                ],
                "rows": [
                    {
                        "row_idx": 2,
                        "row": row(),
                        "truncated_cells": [],
                    }
                ],
                "num_rows_total": 1,
                "num_rows_per_page": 100,
                "partial": False,
            }
        ).encode()

    problems = fetch_swebench_verified(
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
        fetch=fetch,
    )

    assert len(problems) == 1
    assert calls == 3


def test_fetch_rejects_dataset_revision_drift_before_rows() -> None:
    calls = 0

    def fetch(url: str) -> bytes:
        nonlocal calls
        calls += 1
        return json.dumps({"sha": "0" * 40}).encode()

    with pytest.raises(SweBenchError, match="revision drift"):
        fetch_swebench_verified(
            (INSTANCE_ID,),
            runtimes={INSTANCE_ID: runtime()},
            fetch=fetch,
        )

    assert calls == 1


def test_fetch_validates_ids_before_remote_query() -> None:
    with pytest.raises(SweBenchError, match="published set"):
        fetch_swebench_verified(
            ("not__published-1",),
            runtimes={},
            fetch=lambda url: pytest.fail(f"unexpected fetch: {url}"),
        )


def test_fetch_rejects_truncated_dataset_cells() -> None:
    def fetch(url: str) -> bytes:
        if "datasets-server" not in url:
            return json.dumps({"sha": SWE_BENCH_REVISION}).encode()
        return json.dumps(
            {
                "features": [],
                "rows": [
                    {
                        "row_idx": 2,
                        "row": row(),
                        "truncated_cells": ["test_patch"],
                    }
                ],
                "num_rows_total": 1,
                "num_rows_per_page": 100,
                "partial": False,
            }
        ).encode()

    with pytest.raises(SweBenchError, match="truncated dataset cells"):
        fetch_swebench_verified(
            (INSTANCE_ID,),
            runtimes={INSTANCE_ID: runtime()},
            fetch=fetch,
        )


def test_loader_rejects_non_array_test_lists() -> None:
    invalid = {**row(), "FAIL_TO_PASS": '"not-an-array"'}

    with pytest.raises(SweBenchError, match="decode to an array"):
        load_swebench_rows(
            (invalid,),
            (INSTANCE_ID,),
            runtimes={INSTANCE_ID: runtime()},
        )


def test_constructor_prompt_excludes_all_sealed_material() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]

    def provider(messages: tuple[Message, ...], budget: int) -> str:
        prompt = "\n".join(message.content for message in messages)
        assert "sealed test patch" not in prompt
        assert "test_ndarray_mixin[False]" not in prompt
        assert "gold solution" not in prompt
        assert budget == 1024
        return construction().model_dump_json()

    built, evidence = construct_phases(
        problem,
        provider,
        model="scripted-constructor",
    )

    assert built == construction()
    assert evidence.accepted


def test_constructor_accepts_exact_json_code_fence() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    output = f"```json\n{construction().model_dump_json()}\n```"

    built, evidence = construct_phases(
        problem,
        lambda messages, budget: output,
        model="scripted-constructor",
    )

    assert built == construction()
    assert evidence.output == output


def test_constructor_normalizes_json_scalar_argument_values() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    payload = construction().model_dump(mode="json")
    payload["source"]["arguments"][0]["value"] = True
    output = json.dumps(payload)

    built, _ = construct_phases(
        problem,
        lambda messages, budget: output,
        model="scripted-constructor",
    )

    assert built.source.arguments[0].value == "true"


def test_swe_overlay_reinjects_symptoms_and_restores_source() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    variants = build_phase_variants(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )
    base = variants.variant(BASE)
    evolved = variants.variant(EVOLVED)

    assert variants.provenance == "reference_based"
    assert len(base.turns) == 1
    assert len(evolved.turns) == 2
    assert base.total_steps == evolved.total_steps == 12
    assert base.total_headroom == evolved.total_headroom == 12 * 4096
    # both conditions carry the same extracted source intent; the SWE base arm
    # used to carry none at all, so the arms did not share an intent.
    for text in (base.turns[0].text, evolved.turns[-1].text):
        assert construction().source.function in text
        assert problem.problem_statement in text
    assert "Do not implement the final issue yet" in evolved.turns[0].text
    order = json.loads(variants.evidence[0].payload)["injected_argument_order"][0][1]
    assert order == ["current_symptom", "target_module"]
    assert evolved.turns[0].text.index("current symptom") < evolved.turns[0].text.index(
        "target module"
    )
    assert all(
        "sealed test patch" not in turn.text
        for variant in variants.variants
        for turn in variant.turns
    )


def test_public_issue_can_name_an_official_test() -> None:
    source = row()
    test_id = json.loads(str(source["FAIL_TO_PASS"]))[0]
    source["problem_statement"] = f"Fix the behavior covered by {test_id}."
    problem = load_swebench_rows(
        (source,),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]

    family = build_phase_variants(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )

    assert test_id in family.variant(BASE).turns[0].text


def test_the_control_accumulates_information_instead_of_repeating_itself() -> None:
    """The defect the retired SWE `matched` arm had, stated as a test.

    It delivered the whole issue statement in every turn, so nothing
    accumulated and the arm isolated nothing. GSM8K revealed one argument per
    turn, which is the documented design and now the shared one.
    """

    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    variants = build_phase_variants(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )
    matched = variants.variant(MATCHED)
    evolved = variants.variant(EVOLVED)

    assert variants.control == MATCHED
    assert len(matched.turns) == len(evolved.turns)
    assert matched.total_steps == evolved.total_steps
    assert matched.total_headroom == evolved.total_headroom
    # the goal never moves, and only the constraints accumulate
    assert all(construction().source.function in turn.text for turn in matched.turns)
    assert problem.problem_statement not in matched.turns[0].text
    assert problem.problem_statement in matched.turns[-1].text
    revealed = construction().source.arguments[0]
    assert revealed.value in matched.turns[0].text
    assert construction().source.arguments[1].value not in matched.turns[0].text


def test_construction_prompts_state_the_schema_they_will_be_parsed_against() -> None:
    """A construction round shipped asking only for "one strict JSON object".

    The schema now comes from the model that validates the reply, so a prompt
    cannot describe a shape its parser does not accept.
    """

    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    prompts: list[str] = []

    def provider(messages, budget: int) -> str:
        prompts.append(messages[0].content)
        return construction().model_dump_json()

    construct_phases(problem, provider, model="scripted-constructor")

    assert prompts
    for prompt in prompts:
        schema = json.loads(prompt.split("JSON Schema:\n", 1)[1])
        assert "predecessors" in json.dumps(schema)
        assert "No Markdown fences" in prompt
