from __future__ import annotations

import json

from run_screening import (
    CONSTRUCTIONS,
    EVIDENCE,
    INSTANCE_DIGESTS,
    WORK,
    _read_constructions,
)

from parallax.canonical import atomic_write, canonical_bytes
from parallax.metering import meter
from parallax.screening import (
    ScreeningPlan,
    ScreeningRun,
    _append_fsync,
    _canonical_line,
    _finalize_partial,
    read_screening_jsonl,
    summarize_screening,
)
from parallax.specs import freeze_swe_specs
from parallax.swebench import (
    SWE_BENCH_HARNESS_REVISION,
    ImageDigest,
    SweBenchProblem,
    SweBenchVerifier,
    build_swe_script_family,
    official_image_ref,
)
from parallax.swebench_harness import run_official_harness

FAILED_SCREENING = EVIDENCE / "screening-wheel-harness-failure.jsonl"
SCREENING = EVIDENCE / "screening.jsonl"
SUMMARY = EVIDENCE / "screening-summary.json"
REGRADE_WORK = EVIDENCE / "live-work-source-regrade"


def _problem(instance_id: str, trial_index: int) -> SweBenchProblem:
    dataset_path = (
        WORK
        / "official-harness"
        / f"swebench:{instance_id}"
        / f"trial-{trial_index}"
        / "dataset.json"
    )
    row = json.loads(dataset_path.read_text(encoding="utf-8"))[0]
    return SweBenchProblem(
        record_id=f"swebench:{instance_id}",
        instance_id=instance_id,
        repo=row["repo"],
        base_commit=row["base_commit"],
        problem_statement=row["problem_statement"],
        version=row["version"],
        difficulty="",
        verifier=SweBenchVerifier(
            harness_revision=SWE_BENCH_HARNESS_REVISION,
            image_ref=official_image_ref(instance_id),
            image_digest=ImageDigest(INSTANCE_DIGESTS[instance_id]),
            gold_patch="historical regrade did not retain the source gold patch",
            test_patch=row["test_patch"],
            fail_to_pass=tuple(row["FAIL_TO_PASS"]),
            pass_to_pass=tuple(row["PASS_TO_PASS"]),
        ),
    )


def main() -> None:
    records = read_screening_jsonl(FAILED_SCREENING)
    plan = records[0]
    if not isinstance(plan, ScreeningPlan):
        raise ValueError("failed screening evidence does not begin with a manifest")
    constructions = _read_constructions()
    if not CONSTRUCTIONS.exists():
        raise FileNotFoundError("construction evidence is missing")
    partial = SCREENING.with_name(f"{SCREENING.name}.partial")
    if SCREENING.exists():
        raise FileExistsError(f"regraded screening already exists: {SCREENING}")
    if partial.exists():
        partial_records = read_screening_jsonl(partial)
        if not partial_records or partial_records[0] != plan:
            raise ValueError("partial regrade manifest differs from the original")
        completed = {
            (record.unit.source_id, record.unit.trial_index, record.unit.arm)
            for record in partial_records[1:]
            if isinstance(record, ScreeningRun)
        }
    else:
        _append_fsync(partial, _canonical_line(plan), exclusive=True)
        completed = set()

    for unit in plan.units:
        key = (unit.source_id, unit.trial_index, unit.arm)
        if key in completed:
            continue
        instance_id = str(unit.source_id).removeprefix("swebench:")
        problem = _problem(instance_id, unit.trial_index)
        if problem.verifier.digest != unit.verifier_digest:
            raise ValueError(f"verifier digest drift for {unit.source_id}")
        construction = constructions[str(problem.record_id)].construction
        family = build_swe_script_family(
            problem,
            construction,
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        task, environment = freeze_swe_specs(family)
        episode_path = (
            WORK / "episodes" / instance_id / f"trial-{unit.trial_index}.json"
        )
        episode = json.loads(episode_path.read_text(encoding="utf-8"))
        evaluation = run_official_harness(
            task,
            environment,
            episode["model_patch"],
            model=episode["reported_model"],
            run_directory=(
                REGRADE_WORK
                / "official-harness"
                / str(unit.source_id)
                / f"trial-{unit.trial_index}"
            ),
            harness_source_directory=REGRADE_WORK / "swebench-harness-source",
        )
        # Re-meter rather than carry the episode's recorded price: these
        # episodes were paid for under the retired Opus rate card, and copying
        # that figure into fresh evidence is how it spread in the first place.
        usage = meter(
            episode["reported_model"],
            prompt_tokens=episode["prompt_tokens"],
            completion_tokens=episode["completion_tokens"],
        )
        run = ScreeningRun(
            design_digest=plan.design_digest,
            model_config_digest=plan.model_config_digest,
            reported_model=episode["reported_model"],
            unit=unit,
            outcome=evaluation.outcome,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            estimated_cost_usd=usage.cost_usd,
            verifier_report_digest=evaluation.report_digest,
            harness_revision=evaluation.harness_revision,
            image_digest=evaluation.image_digest,
        )
        _append_fsync(partial, _canonical_line(run))
        print(
            f"REGRADE_RESULT source={instance_id} trial={unit.trial_index} "
            f"verdict={evaluation.outcome.verdict}"
        )

    _finalize_partial(partial, SCREENING)
    final_records = read_screening_jsonl(SCREENING)
    runs = tuple(
        record for record in final_records[1:] if isinstance(record, ScreeningRun)
    )
    summary = summarize_screening(plan, runs)
    atomic_write(SUMMARY, canonical_bytes(summary) + b"\n")
    print(canonical_bytes(summary).decode())


if __name__ == "__main__":
    main()
