from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import os
from pathlib import Path

from pyarrow.parquet import read_table

from parallax.admission import AdmittedSweFamily, read_admission_record
from parallax.canonical import atomic_write, canonical_bytes
from parallax.hud_screening import HudExecutor
from parallax.screening import (
    ScreeningCost,
    ScreeningExecution,
    ScreeningPlan,
    ScreeningRun,
    ScreeningUnit,
    build_admitted_screening_plan,
    read_screening_jsonl,
    run_screening,
)
from parallax.swebench import (
    ImageDigest,
    SweConstruction,
    VerifierRuntime,
    build_swe_script_family,
    load_swebench_rows,
)

ROOT = Path(__file__).parent
PREREQUISITES = ROOT.parent / "swebench-experiment-prerequisites-20260803"
ROUND_TWO = ROOT.parent / "swebench-screening-round2-20260803"
EVIDENCE = ROOT / "evidence"
WORK = EVIDENCE / "live-work"
EXPERIMENT = EVIDENCE / "experiment.jsonl"
LINKAGE = EVIDENCE / "preregistration-linkage.json"
DESIGN = PREREQUISITES / "evidence" / "single-vs-evolved-design.json"
DESIGN_DIGEST = "e230043ce85483b90e636b594e828dd78f525ddd9fd4bc6a25bf11caeeda4eaa"
PARQUET = Path("/tmp/swebench-verified-91aa3ed.parquet")
PARQUET_DIGEST = "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21"
HARNESS_SOURCE = (
    ROUND_TWO / "evidence" / "remaining-medium-live-work" / "swebench-harness-source"
)
CONSTRUCTION_FILES = (
    ROUND_TWO / "evidence" / "construction.jsonl",
    ROUND_TWO / "evidence" / "remaining-medium-construction.jsonl",
)
INSTANCE_DIGESTS = {
    "astropy__astropy-14508": (
        "a6aea03ce1c6a2e897e78a4339e44f02643deb9007e0628a058034779181ce71"
    ),
    "django__django-13786": (
        "28706e5b427da7f7d47bedf1df9e5b5f23e730d02f62a56da7ae70cb4998e8e5"
    ),
    "pydata__xarray-4695": (
        "7ef6875f4261882984f8bf90705f5acbd99151ab45bfabdf97885bf440aaee6f"
    ),
}
MODEL = "claude-opus-4-8"
TRIAL_SEEDS = (2026080401, 2026080402, 2026080403)
ARMS = ("static", "evolved")
SPEND_CAP_USD = 25.0
EPISODE_COST = ScreeningCost(
    lower_per_episode_usd=0.10,
    upper_per_episode_usd=0.30,
)
FRAME_LIMIT_BYTES = 16 * 1024 * 1024


def raise_hud_stream_limit() -> None:
    """hud 0.6.12 reads control-channel frames with StreamReader.readline()
    on connections opened at asyncio's default 64 KiB limit. A frame larger
    than that (a long shell tool result, or the grade frame embedding the
    full candidate patch) raises LimitOverrunError and destroys an
    otherwise complete paid episode. Raise the default limit process-wide
    before any episode runs."""
    original = asyncio.open_connection
    if getattr(original, "_parallax_frame_limit", None) == FRAME_LIMIT_BYTES:
        return

    @functools.wraps(original)
    async def patched(host=None, port=None, **kwargs):
        kwargs.setdefault("limit", FRAME_LIMIT_BYTES)
        return await original(host, port, **kwargs)

    patched._parallax_frame_limit = FRAME_LIMIT_BYTES
    asyncio.open_connection = patched


def _constructions() -> dict[str, SweConstruction]:
    selected = {f"swebench:{instance_id}" for instance_id in INSTANCE_DIGESTS}
    constructions: dict[str, SweConstruction] = {}
    for path in CONSTRUCTION_FILES:
        for line in path.read_text(encoding="utf-8").splitlines():
            value = json.loads(line)
            source_id = value["source_id"]
            if source_id in selected:
                constructions[source_id] = SweConstruction.model_validate_json(
                    json.dumps(value["construction"])
                )
    if set(constructions) != selected:
        raise ValueError("round-two construction evidence is incomplete")
    return constructions


def _admitted_families() -> tuple[AdmittedSweFamily, ...]:
    if hashlib.sha256(PARQUET.read_bytes()).hexdigest() != PARQUET_DIGEST:
        raise ValueError("pinned Verified parquet digest mismatch")
    instance_ids = tuple(INSTANCE_DIGESTS)
    rows = {
        row["instance_id"]: row
        for row in read_table(PARQUET).to_pylist()
        if row["instance_id"] in INSTANCE_DIGESTS
    }
    problems = load_swebench_rows(
        tuple(rows[instance_id] for instance_id in instance_ids),
        instance_ids,
        runtimes={
            instance_id: VerifierRuntime(image_digest=ImageDigest(digest))
            for instance_id, digest in INSTANCE_DIGESTS.items()
        },
    )
    constructions = _constructions()
    admitted = []
    for problem in problems:
        family = build_swe_script_family(
            problem,
            constructions[str(problem.record_id)],
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        record = read_admission_record(
            PREREQUISITES / "evidence" / str(problem.instance_id) / "admission.json"
        )
        admitted.append(AdmittedSweFamily(family=family, admission=record))
    return tuple(admitted)


def _check_preregistration(plan: ScreeningPlan) -> None:
    design = json.loads(DESIGN.read_text(encoding="utf-8"))
    if design["design_digest"] != DESIGN_DIGEST:
        raise ValueError("preregistered design digest drift")
    if plan.model != design["model"]:
        raise ValueError("plan model differs from preregistered design")
    if plan.expected_response_model != design["expected_response_model"]:
        raise ValueError("plan response model differs from preregistered design")
    expected = sorted(
        (
            unit["source_id"],
            unit["trial_index"],
            unit["trial_seed"],
            unit["arm"],
        )
        for unit in design["units"]
    )
    actual = sorted(
        (
            str(unit.source_id),
            int(unit.trial_index),
            int(unit.trial_seed),
            str(unit.arm),
        )
        for unit in plan.units
    )
    if expected != actual:
        raise ValueError("plan units differ from the preregistered 18 units")
    atomic_write(
        LINKAGE,
        canonical_bytes(
            {
                "preregistered_design_digest": DESIGN_DIGEST,
                "preregistered_unit_count": len(design["units"]),
                "screening_design_digest": str(plan.design_digest),
                "unit_correspondence": "exact",
            }
        )
        + b"\n",
    )


class ArmDispatchExecutor:
    """One HudExecutor per arm: the executor's episode cache and harness
    run directories key on instance and trial only, so static and evolved
    units of the same trial would otherwise collide."""

    def __init__(self, families) -> None:
        self.executors = {}
        for arm in ARMS:
            directory = WORK / arm
            directory.mkdir(parents=True, exist_ok=True)
            link = directory / "swebench-harness-source"
            if not link.exists():
                link.symlink_to(HARNESS_SOURCE.resolve())
            self.executors[arm] = HudExecutor(
                families,
                model=MODEL,
                work_directory=directory,
            )

    def __call__(self, unit: ScreeningUnit) -> ScreeningExecution:
        print(
            f"EXPERIMENT_UNIT_START source={unit.source_id} "
            f"trial={unit.trial_index} arm={unit.arm}",
            flush=True,
        )
        execution = self.executors[str(unit.arm)](unit)
        print(
            f"EXPERIMENT_UNIT_DONE source={unit.source_id} "
            f"trial={unit.trial_index} arm={unit.arm} "
            f"outcome={execution.outcome.kind} "
            f"cost_usd={execution.estimated_cost_usd:.6f}",
            flush=True,
        )
        return execution


def main() -> None:
    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is required")
    os.environ.setdefault("DOCKER_DEFAULT_PLATFORM", "linux/amd64")
    raise_hud_stream_limit()
    admitted = _admitted_families()
    plan = build_admitted_screening_plan(
        admitted,
        model=MODEL,
        expected_response_model=MODEL,
        trial_seeds=TRIAL_SEEDS,
        arms=ARMS,
        cost=EPISODE_COST,
    )
    _check_preregistration(plan)
    families = {
        str(item.family.static.problem.record_id): item.family for item in admitted
    }
    if EXPERIMENT.exists():
        records = read_screening_jsonl(EXPERIMENT)
        if records[0] != plan or not isinstance(records[0], ScreeningPlan):
            raise ValueError("completed experiment manifest drift")
        runs = tuple(
            record for record in records[1:] if isinstance(record, ScreeningRun)
        )
    else:
        runs = run_screening(
            plan,
            ArmDispatchExecutor(families),
            output_path=EXPERIMENT,
            approve_spend=True,
            spend_cap_usd=SPEND_CAP_USD,
        )
    total_cost = sum(run.estimated_cost_usd for run in runs)
    print(
        json.dumps(
            {
                "completed_units": len(runs),
                "design_digest": str(plan.design_digest),
                "experiment_cost_usd": total_cost,
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
