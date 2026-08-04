from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import pytest
from conftest import HistoryAgent, LastMessageAgent, make_family
from pydantic import TypeAdapter, ValidationError

from parallax.canonical import canonical_bytes, canonical_digest
from parallax.evolving_intent import Arm, Chat, Message, Script, ScriptFamily
from parallax.gsm8k import Verdict, Verification
from parallax.report import build_report, report_from_jsonl
from parallax.runner import (
    BudgetError,
    EvidenceRecord,
    FamilyRecord,
    ManifestRecord,
    Outcome,
    RunFailure,
    RunRecord,
    RunResult,
    read_run_jsonl,
    run_experiment,
)
from parallax.types import DesignDigest, ModelConfigDigest, TrialSeed

_EVIDENCE = TypeAdapter(tuple[EvidenceRecord, ...])


def history_factory(source_id: str, arm: Arm, seed: int) -> Chat:
    return HistoryAgent()


def run(
    families: tuple[ScriptFamily, ...],
    factory: object,
    path: Path,
    *,
    seeds: tuple[int, ...] = (11, 12),
) -> tuple[RunResult, ...]:
    return run_experiment(
        families,
        factory,
        trial_seeds=seeds,
        agent_model="offline-agent",
        model_config={"temperature": 0, "provider": "scripted"},
        output_path=path,
    )


def _json_records(records: tuple[EvidenceRecord, ...]) -> list[dict[str, object]]:
    return [record.model_dump(mode="json") for record in records]


def _write_records(path: Path, records: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(
            json.dumps(
                record,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
            for record in records
        ),
        encoding="utf-8",
    )


def test_history_is_required_for_evolved_fixture(
    family: ScriptFamily, tmp_path: Path
) -> None:
    history = run((family,), history_factory, tmp_path / "history.jsonl", seeds=(17,))
    last = run(
        (family,),
        lambda source, arm, seed: LastMessageAgent(),
        tmp_path / "last.jsonl",
        seeds=(17,),
    )
    history_evolved = next(
        result for result in history if result.identity.arm == "evolved"
    )
    last_evolved = next(result for result in last if result.identity.arm == "evolved")

    assert isinstance(history_evolved.outcome, Verification)
    assert history_evolved.outcome.verdict is Verdict.PASS
    assert isinstance(last_evolved.outcome, Verification)
    assert last_evolved.outcome.verdict is Verdict.WRONG


def test_outcome_union_has_an_explicit_discriminator() -> None:
    schema = TypeAdapter(Outcome).json_schema()

    assert schema["discriminator"]["propertyName"] == "kind"


def test_canonical_json_rejects_nonfinite_numbers() -> None:
    with pytest.raises(ValueError, match="not JSON compliant"):
        canonical_bytes({"value": float("nan")})


def test_manifest_requires_scheduled_units() -> None:
    model_digest = ModelConfigDigest("0" * 64)
    body = {
        "schema_version": 1,
        "model_config_digest": model_digest,
        "units": [],
        "arm_config_digests": [],
    }

    with pytest.raises(ValidationError, match="at least 1 item"):
        ManifestRecord(
            design_digest=DesignDigest(canonical_digest(body)),
            model_config_digest=model_digest,
            units=(),
            arm_config_digests=(),
        )


def test_evidence_and_report_are_byte_stable_and_order_invariant(
    family: ScriptFamily, tmp_path: Path
) -> None:
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    run((family,), history_factory, first)
    run((family,), history_factory, second)

    assert first.read_bytes() == second.read_bytes()
    assert (
        hashlib.sha256(first.read_bytes()).hexdigest()
        == "9ee049a877ee3ddc92c8580120f6ed9405892eaee69e7ee614be3baa5c105d22"
    )
    records = read_run_jsonl(first)
    assert sum(record.kind == "manifest" for record in records) == 1
    assert sum(record.kind == "family" for record in records) == 1
    family_record = next(
        record for record in records if isinstance(record, FamilyRecord)
    )
    assert family_record.answer_authority == "18"
    assert all(
        "answer_authority" not in record.model_dump()
        for record in records
        if isinstance(record, RunRecord)
    )
    assert first.read_text().count('"answer_authority":"18"') == 1
    assert '"kind":"reveal"' in first.read_text()
    assert '"kind":"revise"' in first.read_text()
    assert '"kind":"switch"' in first.read_text()

    def require_sorted_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        keys = [key for key, _ in pairs]
        assert keys == sorted(keys)
        return dict(pairs)

    for line in first.read_text().splitlines():
        json.loads(line, object_pairs_hook=require_sorted_keys)
    shuffled = list(_json_records(records))
    random.Random(4).shuffle(shuffled)
    shuffled_path = tmp_path / "shuffled.jsonl"
    _write_records(shuffled_path, shuffled)
    first_report = tmp_path / "first-report.json"
    shuffled_report = tmp_path / "shuffled-report.json"
    assert report_from_jsonl(first, first_report) == report_from_jsonl(
        shuffled_path, shuffled_report
    )
    assert first_report.read_bytes() == shuffled_report.read_bytes()


def test_factory_exception_is_a_scheduled_run_failure(
    family: ScriptFamily, tmp_path: Path
) -> None:
    def factory(source_id: str, arm: Arm, seed: int) -> Chat:
        if arm == "matched":
            raise TimeoutError("factory timeout")
        return HistoryAgent()

    results = run((family,), factory, tmp_path / "factory.jsonl", seeds=(1,))
    matched = next(result for result in results if result.identity.arm == "matched")
    report = report_from_jsonl(
        tmp_path / "factory.jsonl", tmp_path / "factory-report.json"
    )

    assert isinstance(matched.outcome, RunFailure)
    assert matched.outcome.failure_kind == "agent"
    assert report["population"]["scheduled_rows"] == 3
    assert report["missing_pairs"]["matched_failure"] == 1


def test_script_rejects_nonpositive_declared_budget(family: ScriptFamily) -> None:
    with pytest.raises(ValidationError, match="greater than 0"):
        Script(
            arm=family.static.arm,
            problem=family.static.problem,
            turns=family.static.turns,
            max_output_tokens=(0,),
        )


def _response(value: str | Exception) -> Chat:
    def respond(messages: tuple[Message, ...], budget: int) -> str:
        if isinstance(value, Exception):
            raise value
        return value

    return respond


def test_agent_budget_fault_remains_a_run_failure(
    family: ScriptFamily, tmp_path: Path
) -> None:
    def factory(source_id: str, arm: Arm, seed: int) -> Chat:
        return _response(BudgetError("provider budget rejected"))

    results = run((family,), factory, tmp_path / "budget.jsonl", seeds=(0,))

    assert all(isinstance(result.outcome, RunFailure) for result in results)
    assert all(
        result.outcome.failure_kind == "budget"
        for result in results
        if isinstance(result.outcome, RunFailure)
    )


def test_rates_complete_difference_and_identification_bounds(
    family: ScriptFamily, tmp_path: Path
) -> None:
    matched = {
        0: "FINAL_ANSWER: 18",
        1: "FINAL_ANSWER: 17",
        2: "18",
        3: TimeoutError("matched timeout"),
    }
    evolved = {
        0: "FINAL_ANSWER: 18",
        1: "FINAL_ANSWER: 18",
        2: TimeoutError("evolved timeout"),
        3: "18",
    }

    def factory(source_id: str, arm: Arm, seed: int) -> Chat:
        if arm == "matched":
            return _response(matched[seed])
        if arm == "evolved":
            return _response(evolved[seed])
        return _response("FINAL_ANSWER: 18")

    evidence = tmp_path / "rates.jsonl"
    run((family,), factory, evidence, seeds=(0, 1, 2, 3))
    report = report_from_jsonl(evidence, tmp_path / "rates-report.json")
    rates = report["arm_rates"]["matched"]

    assert rates["pass_rate"] == 1 / 3
    assert rates["model_failure_rate"] == 2 / 3
    assert rates["run_failure_rate"] == 1 / 4
    assert rates["operational_pass_rate"] == 1 / 4
    assert report["paired_count"] == 2
    assert report["difference"] == 0.5
    assert report["identification_bounds"] == {"lower": 0.0, "upper": 0.5}


def test_source_clustered_hoeffding_golden(tmp_path: Path) -> None:
    families = tuple(make_family(source_id=f"source-{index}")[0] for index in range(50))
    evidence = tmp_path / "fifty.jsonl"
    run(families, history_factory, evidence, seeds=(0, 1, 2))
    report = report_from_jsonl(evidence, tmp_path / "fifty-report.json")

    assert report["interval"]["lower"] == -0.38412911652796833
    assert report["interval"]["upper"] == 0.38412911652796833
    assert report["interval"]["minimum_detectable_effect"] == 0.38412911652796833
    assert report["population"]["source_clusters"] == 50

    positive = list(read_run_jsonl(evidence))
    negative = list(read_run_jsonl(evidence))
    for records, matched, evolved in (
        (positive, Verdict.WRONG, Verdict.PASS),
        (negative, Verdict.PASS, Verdict.WRONG),
    ):
        for index, record in enumerate(records):
            if not isinstance(record, RunRecord) or record.arm == "static":
                continue
            verdict = matched if record.arm == "matched" else evolved
            records[index] = record.model_copy(
                update={
                    "outcome": Verification(
                        verdict=verdict,
                        reason="golden decision fixture",
                    )
                }
            )
    positive_report = build_report(tuple(positive))
    negative_report = build_report(tuple(negative))
    assert positive_report["difference"] == 1.0
    assert negative_report["difference"] == -1.0
    assert positive_report["interval"] == {
        "confidence": 0.95,
        "method": "source_clustered_hoeffding",
        "epsilon": 0.38412911652796833,
        "lower": 0.6158708834720317,
        "minimum_detectable_effect": 0.38412911652796833,
        "upper": 1.0,
    }
    assert negative_report["interval"] == {
        "confidence": 0.95,
        "method": "source_clustered_hoeffding",
        "epsilon": 0.38412911652796833,
        "lower": -1.0,
        "minimum_detectable_effect": 0.38412911652796833,
        "upper": -0.6158708834720317,
    }


def test_single_source_interval_is_uninformative(tmp_path: Path) -> None:
    family, _ = make_family()
    evidence = tmp_path / "single.jsonl"
    run((family,), history_factory, evidence, seeds=(0,))

    report = report_from_jsonl(evidence, tmp_path / "single-report.json")

    assert report["interval"]["lower"] == -1.0
    assert report["interval"]["upper"] == 1.0
    assert report["interval"]["minimum_detectable_effect"] == 2.716203031481239


def test_seed_drift_names_key_and_both_seeds(
    family: ScriptFamily, tmp_path: Path
) -> None:
    evidence = tmp_path / "seed.jsonl"
    run((family,), history_factory, evidence, seeds=(7,))
    records = list(read_run_jsonl(evidence))
    index = next(
        index for index, record in enumerate(records) if isinstance(record, RunRecord)
    )
    records[index] = records[index].model_copy(update={"trial_seed": TrialSeed(8)})

    with pytest.raises(
        ValueError,
        match=r"seed_drift: key=\('gsm8k-1', 0\), expected=7, actual=8",
    ):
        build_report(tuple(records))


def test_structural_and_identity_drift_are_rejected(
    family: ScriptFamily, tmp_path: Path
) -> None:
    evidence = tmp_path / "structure.jsonl"
    run((family,), history_factory, evidence, seeds=(7,))
    records = list(read_run_jsonl(evidence))
    run_index = next(
        index for index, record in enumerate(records) if isinstance(record, RunRecord)
    )

    with pytest.raises(ValueError, match="duplicate_unit_arm"):
        build_report(tuple([*records, records[run_index]]))
    with pytest.raises(ValueError, match="missing_scheduled_rows"):
        build_report(tuple(records[:run_index] + records[run_index + 1 :]))
    drifted = list(records)
    drifted[run_index] = drifted[run_index].model_copy(
        update={"model_config_digest": "0" * 64}
    )
    with pytest.raises(ValueError, match="config_drift"):
        build_report(tuple(drifted))
    family_index = next(
        index
        for index, record in enumerate(records)
        if isinstance(record, FamilyRecord)
    )
    family_record = records[family_index]
    assert isinstance(family_record, FamilyRecord)
    static = family_record.scripts["static"]
    tampered_static = static.model_copy(
        update={
            "turns": (
                static.turns[0].model_copy(update={"text": "tampered"}),
                *static.turns[1:],
            )
        }
    )
    drifted = list(records)
    drifted[family_index] = family_record.model_copy(
        update={"scripts": {**family_record.scripts, "static": tampered_static}}
    )
    with pytest.raises(ValueError, match="family_arm_digest_drift"):
        build_report(tuple(drifted))


@pytest.mark.parametrize(
    "change",
    [
        {"extra": True},
        {"trial_seed": "7"},
        {"trial_index": -1},
        {"arm": "unknown"},
        {"model_config_digest": "drift"},
    ],
)
def test_jsonl_boundary_is_strict_and_forbids_extras(
    family: ScriptFamily,
    tmp_path: Path,
    change: dict[str, object],
) -> None:
    evidence = tmp_path / "valid.jsonl"
    run((family,), history_factory, evidence, seeds=(7,))
    records = _json_records(read_run_jsonl(evidence))
    run_record = next(record for record in records if record["kind"] == "run")
    run_record.update(change)
    bad = tmp_path / "bad.jsonl"
    _write_records(bad, records)

    with pytest.raises(ValueError, match="line"):
        read_run_jsonl(bad)


@pytest.mark.parametrize(
    ("kind", "change"),
    [
        ("manifest", {"design_digest": "0" * 64}),
        ("manifest", {"units": []}),
        ("family", {"scripts": {}}),
        ("family", {"answer_authority": "01"}),
    ],
)
def test_record_level_invariants_are_enforced_at_read(
    family: ScriptFamily,
    tmp_path: Path,
    kind: str,
    change: dict[str, object],
) -> None:
    evidence = tmp_path / "valid.jsonl"
    run((family,), history_factory, evidence, seeds=(7,))
    records = _json_records(read_run_jsonl(evidence))
    record = next(item for item in records if item["kind"] == kind)
    record.update(change)
    bad = tmp_path / "bad-record.jsonl"
    _write_records(bad, records)

    with pytest.raises(ValueError, match="line"):
        read_run_jsonl(bad)


def test_nested_outcome_forbids_extra_fields(
    family: ScriptFamily, tmp_path: Path
) -> None:
    evidence = tmp_path / "valid.jsonl"
    run((family,), history_factory, evidence, seeds=(7,))
    records = _json_records(read_run_jsonl(evidence))
    run_record = next(record for record in records if record["kind"] == "run")
    outcome = run_record["outcome"]
    assert isinstance(outcome, dict)
    outcome["extra"] = True
    bad = tmp_path / "bad-outcome.jsonl"
    _write_records(bad, records)

    with pytest.raises(ValueError, match="line"):
        read_run_jsonl(bad)


def test_jsonl_reader_rejects_nonobject_records(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    path.write_text("[]\n", encoding="utf-8")

    with pytest.raises(ValueError, match="line 1"):
        read_run_jsonl(path)
