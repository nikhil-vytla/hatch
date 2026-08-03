from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import Field

from parallax.canonical import atomic_write, canonical_bytes
from parallax.hud_screening import CLAUDE_OPUS_PRICING, HudStaticExecutor
from parallax.provider import HudGatewayProvider
from parallax.screening import (
    ScreeningCost,
    ScreeningPlan,
    ScreeningRun,
    build_screening_plan,
    read_screening_jsonl,
    run_screening,
    summarize_screening,
)
from parallax.swebench import (
    ImageDigest,
    SweConstruction,
    VerifierRuntime,
    build_swe_script_family,
    construct_swe_intent,
    fetch_swebench_verified,
)
from parallax.types import NonEmptyText, SourceId, StrictModel

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
WORK = EVIDENCE / "live-work"
CONSTRUCTIONS = EVIDENCE / "construction.jsonl"
SCREENING = EVIDENCE / "screening.jsonl"
SUMMARY = EVIDENCE / "screening-summary.json"
SPEND_CAP_USD = 5.0
CONSTRUCTION_MODEL = "claude-haiku-4-5"
BOUNDARY_MODEL = "claude-opus-4-8"
INSTANCE_DIGESTS = {
    "astropy__astropy-13236": (
        "a43e166eb5ae9e477349b87d800ece7648f8c746f88d94f6f6cff0df1e2caf82"
    ),
    "django__django-10914": (
        "f821080544e1fe3d31e483adbfdf2cc25850f42add4068de5b1dda8935f4d2cb"
    ),
    "django__django-13089": (
        "3a8463419d06d9527d4a079e85c1e29af93cabfdd1c822298cd9639bf9f8b2e7"
    ),
    "matplotlib__matplotlib-20676": (
        "e49c892dea5b9a208f93d822f40985f837eb3bc912116044c5418e740b3a56c9"
    ),
    "psf__requests-5414": (
        "168ae94842a3fb649583fe31fddea447fe17504fef03a858750dc8d8f21a8326"
    ),
}
INSTANCE_IDS = tuple(INSTANCE_DIGESTS)


class ConstructionReceipt(StrictModel):
    source_id: SourceId
    requested_model: NonEmptyText
    reported_model: NonEmptyText
    prompt_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    estimated_cost_usd: float = Field(ge=0)
    construction: SweConstruction


def _append(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as output:
        output.write(canonical_bytes(value) + b"\n")
        output.flush()
        os.fsync(output.fileno())


def _read_constructions() -> dict[str, ConstructionReceipt]:
    if not CONSTRUCTIONS.exists():
        return {}
    receipts = {
        str(receipt.source_id): receipt
        for line in CONSTRUCTIONS.read_bytes().splitlines()
        if line
        for receipt in (ConstructionReceipt.model_validate_json(line),)
    }
    if len(receipts) != len(CONSTRUCTIONS.read_bytes().splitlines()):
        raise ValueError("duplicate construction receipts")
    return receipts


def _construct(problems) -> tuple[dict[str, SweConstruction], float]:
    receipts = _read_constructions()
    provider = HudGatewayProvider(CONSTRUCTION_MODEL)
    for problem in problems:
        source_id = str(problem.record_id)
        if source_id in receipts:
            continue
        responses = []

        def chat(messages, max_output_tokens, _responses=responses):
            text, response = provider.text_completion(messages, max_output_tokens)
            _responses.append(response)
            return text

        evidence = construct_swe_intent(
            problem,
            chat,
            model=CONSTRUCTION_MODEL,
            max_output_tokens=1024,
        )
        if len(responses) != 1 or responses[0].usage is None:
            raise RuntimeError("construction response omitted usage")
        response = responses[0]
        usage = response.usage
        cost = (
            usage.prompt_tokens * CLAUDE_OPUS_PRICING.input_usd_per_million
            + usage.completion_tokens * CLAUDE_OPUS_PRICING.output_usd_per_million
        ) / 1_000_000
        receipt = ConstructionReceipt(
            source_id=problem.record_id,
            requested_model=CONSTRUCTION_MODEL,
            reported_model=response.model,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            estimated_cost_usd=cost,
            construction=evidence.construction,
        )
        _append(CONSTRUCTIONS, receipt)
        receipts[source_id] = receipt
        print(
            f"CONSTRUCTION_USAGE source={problem.instance_id} cost_usd={cost:.6f}",
            flush=True,
        )
        if sum(item.estimated_cost_usd for item in receipts.values()) >= SPEND_CAP_USD:
            raise RuntimeError("construction exhausted the screening spend cap")
    expected = {str(problem.record_id) for problem in problems}
    if set(receipts) != expected:
        raise ValueError("construction receipts do not match screening sources")
    cost = sum(receipt.estimated_cost_usd for receipt in receipts.values())
    return {key: value.construction for key, value in receipts.items()}, cost


def main() -> None:
    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is required")
    runtimes = {
        instance_id: VerifierRuntime(image_digest=ImageDigest(digest))
        for instance_id, digest in INSTANCE_DIGESTS.items()
    }
    problems = fetch_swebench_verified(INSTANCE_IDS, runtimes=runtimes)
    constructions, construction_cost = _construct(problems)
    families = {
        str(problem.record_id): build_swe_script_family(
            problem,
            constructions[str(problem.record_id)],
            seed=20260802,
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        for problem in problems
    }
    remaining = SPEND_CAP_USD - construction_cost
    upper = (remaining - 0.000001) / (len(problems) * 2)
    if upper < 0.10:
        raise RuntimeError("insufficient spend cap remains for preregistered screening")
    plan = build_screening_plan(
        problems,
        model=BOUNDARY_MODEL,
        expected_response_model=BOUNDARY_MODEL,
        trial_seeds=(2026080201, 2026080202),
        cost=ScreeningCost(upper_per_episode_usd=upper),
    )
    if SCREENING.exists():
        records = read_screening_jsonl(SCREENING)
        stored_plan = records[0]
        if stored_plan != plan or not isinstance(stored_plan, ScreeningPlan):
            raise ValueError("completed screening manifest drift")
        runs = tuple(
            record for record in records[1:] if isinstance(record, ScreeningRun)
        )
    else:
        executor = HudStaticExecutor(
            families,
            model=BOUNDARY_MODEL,
            work_directory=WORK,
        )
        runs = run_screening(
            plan,
            executor,
            SCREENING,
            approved=True,
            spend_cap_usd=remaining,
        )
    summary = summarize_screening(plan, runs)
    atomic_write(SUMMARY, canonical_bytes(summary) + b"\n")
    print(
        json.dumps(
            {
                "construction_cost_usd": construction_cost,
                "screening_cost_usd": sum(run.estimated_cost_usd for run in runs),
                "summary": summary.model_dump(mode="json"),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
