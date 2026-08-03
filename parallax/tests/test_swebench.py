from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from parallax.evolving_intent import Message
from parallax.swebench import (
    INITIAL_SCREENING_IDS,
    PUBLISHED_INSTANCE_IDS,
    SWE_BENCH_REVISION,
    ImageDigest,
    SweArgument,
    SweBenchError,
    SweConstruction,
    SweIntent,
    SweScriptFamily,
    VerifierRuntime,
    build_swe_script_family,
    construct_swe_intent,
    fetch_swebench_verified,
    load_swebench_rows,
)

INSTANCE_ID = "astropy__astropy-13236"


def test_published_source_set_is_exact_and_screening_is_a_subset() -> None:
    assert len(PUBLISHED_INSTANCE_IDS) == 50
    assert len(set(PUBLISHED_INSTANCE_IDS)) == 50
    assert len(INITIAL_SCREENING_IDS) == 10
    assert set(INITIAL_SCREENING_IDS) < set(PUBLISHED_INSTANCE_IDS)


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


def construction() -> SweConstruction:
    return SweConstruction(
        source=SweIntent(
            function="preserve structured ndarray columns",
            arguments=(
                SweArgument(
                    identifier="observed_symptom",
                    value="structured arrays become NdarrayMixin",
                    category="symptom",
                ),
                SweArgument(
                    identifier="required_behavior",
                    value="construct a regular Column",
                    category="constraint",
                ),
            ),
        ),
        predecessors=(
            SweIntent(
                function="inspect table column conversion",
                arguments=(
                    SweArgument(
                        identifier="current_symptom",
                        value="automatic mixin conversion occurs",
                        category="symptom",
                    ),
                    SweArgument(
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
    assert "gold solution" not in problem.model_dump_json()


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

    evidence = construct_swe_intent(
        problem,
        provider,
        model="scripted-constructor",
    )

    assert evidence.construction == construction()


def test_constructor_accepts_exact_json_code_fence() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    output = f"```json\n{construction().model_dump_json()}\n```"

    evidence = construct_swe_intent(
        problem,
        lambda messages, budget: output,
        model="scripted-constructor",
    )

    assert evidence.construction == construction()
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

    evidence = construct_swe_intent(
        problem,
        lambda messages, budget: output,
        model="scripted-constructor",
    )

    assert evidence.construction.source.arguments[0].value == "true"


def test_swe_overlay_reinjects_symptoms_and_restores_source() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    family = build_swe_script_family(
        problem,
        construction(),
        seed=7,
        total_agent_steps=12,
        max_output_tokens=4096,
    )

    assert family.static.turns[0].text == problem.problem_statement
    assert len(family.matched.turns) == len(family.evolved.turns) == 2
    assert {script.total_agent_steps for script in family.scripts} == {12}
    assert {script.max_output_tokens for script in family.scripts} == {4096}
    assert family.evolved.turns[-1].state_after.intent == construction().source
    assert all(
        turn.state_after.intent == construction().source
        for turn in family.matched.turns
    )
    predecessor_order = family.overlay.injected_argument_order[0][1]
    assert predecessor_order == ("current_symptom", "target_module")
    assert family.evolved.turns[0].text.index("current symptom") < family.evolved.turns[
        0
    ].text.index("target module")
    assert all(
        "sealed test patch" not in turn.text
        for script in family.scripts
        for turn in script.turns
    )


def test_episode_budget_rejects_fewer_steps_than_turns() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]

    with pytest.raises(SweBenchError, match="cover every turn"):
        build_swe_script_family(
            problem,
            construction(),
            seed=0,
            total_agent_steps=1,
            max_output_tokens=1024,
        )


def test_swe_family_rejects_budget_and_restoration_drift() -> None:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    valid = build_swe_script_family(
        problem,
        construction(),
        seed=0,
        total_agent_steps=12,
        max_output_tokens=1024,
    )
    bad_static = valid.static.model_copy(update={"agent_steps": (1,)})
    with pytest.raises(ValidationError, match="equal episode budgets"):
        SweScriptFamily(
            construction_seed=valid.construction_seed,
            construction=valid.construction,
            static=bad_static,
            matched=valid.matched,
            evolved=valid.evolved,
            overlay=valid.overlay,
        )
    bad_final = valid.evolved.turns[-1].model_copy(
        update={"state_after": valid.evolved.turns[0].state_after}
    )
    bad_evolved = valid.evolved.model_copy(
        update={"turns": (*valid.evolved.turns[:-1], bad_final)}
    )
    with pytest.raises(ValidationError, match="restore source intent"):
        SweScriptFamily(
            construction_seed=valid.construction_seed,
            construction=valid.construction,
            static=valid.static,
            matched=valid.matched,
            evolved=bad_evolved,
            overlay=valid.overlay,
        )
