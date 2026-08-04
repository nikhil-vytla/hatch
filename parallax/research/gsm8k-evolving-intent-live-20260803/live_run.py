"""Drive the GSM8K Evolving Intent three-arm experiment against a real model.

Phases, in order:

1. ``ingest``     -- read the pinned official GSM8K test split, keep rows whose
                     sealed answer is already a canonical integer, and select a
                     preregistered candidate sample.
2. ``construct``  -- run the LLM construction pipeline (extract-intent,
                     argument counterfactuals, predecessor) for real, once per
                     candidate source. Admitted families are cached on disk.
3. ``warm``       -- execute every (source, trial, arm) episode concurrently so
                     each provider call lands in the response cache. Repeatable
                     and idempotent; this is what makes a crash resumable.
4. ``evidence``   -- replay every episode sequentially through
                     ``runner.run_experiment`` so the canonical evidence JSONL
                     is written by the package's own code path. Warm cache hits
                     make this free.

Cost is metered from the response cache, where each file is exactly one paid
provider call, so repeated passes cannot double-count.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from parallax.canonical import atomic_write, canonical_bytes, canonical_digest
from parallax.evolving_intent import (
    Arm,
    ConstructionError,
    Message,
    ScriptFamily,
    build_script_family,
)
from parallax.gsm8k import Gsm8kError, Problem, parse_source_answer
from parallax.hud_screening import CLAUDE_HAIKU_PRICING
from parallax.outcome import BudgetError
from parallax.provider import HUD_GATEWAY_ENDPOINT, HudGatewayProvider, ProviderError
from parallax.runner import RunIdentity, run_experiment, run_script
from parallax.types import NonEmptyText, SourceAnswer, SourceId, StrictModel

ROOT = Path(__file__).parent
WORK = ROOT / "work"
EVIDENCE = ROOT / "evidence"
DATASET = WORK / "gsm8k-test.jsonl"
DATASET_SHA256 = "3730d312f6e3440559ace48831e51066acaca737f6eabec99bccb9e4b3c39d14"
DATASET_URL = (
    "https://raw.githubusercontent.com/openai/grade-school-math/master/"
    "grade_school_math/data/test.jsonl"
)

MODEL = "claude-haiku-4-5"
EXPECTED_REPORTED_MODEL = "claude-haiku-4-5-20251001"
CONSTRUCTION_MODEL = MODEL
TEMPERATURE = 1.0
CONSTRUCTION_TEMPERATURE = 0.0
PER_TURN_OUTPUT_TOKENS = 512
CONSTRUCTION_SEED = 20260803
SELECTION_SEED = 20260803
MAXIMUM_ARGUMENTS = 6

# Burned on the calibration pilot before the design was frozen, so held out of
# the main population.
PILOT_SOURCE_IDS = frozenset(
    {
        "gsm8k-test-0295",
        "gsm8k-test-0498",
        "gsm8k-test-1101",
        "gsm8k-test-1306",
    }
)

# The submission contract. Sent as one system message, byte-identical for every
# arm, so it equalises presentation and cannot confound the arm contrast.
SYSTEM_PROMPT = """You are solving a grade-school arithmetic request. The user \
reveals the request over one or more turns and may correct earlier values or \
change the goal.

Answer for the user's goal and values as they stand after the latest turn.

End every reply with a final line of exactly this form:

FINAL_ANSWER: <integer>

That line is graded mechanically, so it must obey all of the following:
- The marker FINAL_ANSWER: appears exactly once in your whole reply, on the \
last non-empty line, with nothing after the integer.
- The integer is plain: no thousands separators, no currency symbol, no units, \
no percent sign, no decimal point, no leading zeros. Negatives look like -42.
- Always give a single best integer, even when you are unsure.

Keep any working before that line short."""


class LiveRunAborted(BaseException):
    """Fatal stop signal for the consecutive-failure brake.

    Deliberately not an ``Exception``: ``runner.run_script`` converts every
    ``Exception`` into a recorded ``RunFailure`` and carries on, which would
    quietly turn a dead gateway into hundreds of fabricated run failures.
    """


class CachedCall(StrictModel):
    scope: Literal["construction", "episode"]
    cache_key: tuple[str, ...]
    call_index: int
    request_digest: str
    kind: Literal["text", "budget_error"]
    text: str | None
    detail: str | None
    reported_model: NonEmptyText
    prompt_tokens: int
    completion_tokens: int

    @property
    def cost_usd(self) -> float:
        return (
            self.prompt_tokens * CLAUDE_HAIKU_PRICING.input_usd_per_million
            + self.completion_tokens * CLAUDE_HAIKU_PRICING.output_usd_per_million
        ) / 1_000_000


class ConstructionReceipt(StrictModel):
    source_id: SourceId
    admitted: bool
    reason: str
    turns: int
    arguments: int


class ResponseCache:
    """Disk cache of individual provider calls, one JSON file per paid call.

    The key always carries the arm and the trial. A key that omits the arm
    silently collides across arms and serves one arm's transcript to another;
    that defect is on record from the SWE-bench screening runs.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.Lock()
        self._consecutive_failures = 0

    def _path(self, scope: str, key: tuple[str, ...], index: int, digest: str) -> Path:
        return self.root.joinpath(scope, *key, f"{index:03d}-{digest[:20]}.json")

    def load(self, path: Path) -> CachedCall | None:
        if not path.exists():
            return None
        return CachedCall.model_validate_json(path.read_bytes())

    def store(self, path: Path, record: CachedCall) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, path.open("wb") as output:
            output.write(canonical_bytes(record) + b"\n")
            output.flush()
            os.fsync(output.fileno())

    def note_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0

    def note_failure(self) -> int:
        with self._lock:
            self._consecutive_failures += 1
            return self._consecutive_failures

    def entries(self) -> list[CachedCall]:
        return [
            CachedCall.model_validate_json(path.read_bytes())
            for path in sorted(self.root.rglob("*.json"))
        ]


MAXIMUM_CONSECUTIVE_FAILURES = 3
RETRY_ATTEMPTS = 5


def cached_chat(
    provider: HudGatewayProvider,
    cache: ResponseCache,
    *,
    scope: Literal["construction", "episode"],
    cache_key: tuple[str, ...],
    temperature: float,
    seed: int | None,
) -> Callable[[tuple[Message, ...], int], str]:
    counter = {"index": 0}

    def chat(messages: tuple[Message, ...], max_output_tokens: int) -> str:
        index = counter["index"]
        counter["index"] += 1
        request_digest = canonical_digest(
            {
                "messages": [message.model_dump(mode="json") for message in messages],
                "max_output_tokens": max_output_tokens,
                "model": MODEL,
                "temperature": temperature,
            }
        )
        path = cache._path(scope, cache_key, index, request_digest)
        record = cache.load(path)
        if record is not None:
            if record.kind == "budget_error":
                raise BudgetError(record.detail or "cached truncation")
            return record.text or ""

        delay = 2.0
        last_error: ProviderError | None = None
        for attempt in range(RETRY_ATTEMPTS):
            try:
                text, response = provider.text_completion(
                    messages,
                    max_output_tokens,
                    temperature=temperature,
                    seed=seed,
                )
            except BudgetError as error:
                cache.note_success()
                cache.store(
                    path,
                    CachedCall(
                        scope=scope,
                        cache_key=cache_key,
                        call_index=index,
                        request_digest=request_digest,
                        kind="budget_error",
                        text=None,
                        detail=str(error),
                        reported_model=EXPECTED_REPORTED_MODEL,
                        prompt_tokens=0,
                        completion_tokens=max_output_tokens,
                    ),
                )
                raise
            except ProviderError as error:
                last_error = error
                if attempt < RETRY_ATTEMPTS - 1:
                    time.sleep(delay + random.random())
                    delay = min(delay * 2, 60.0)
                continue
            usage = response.usage
            cache.note_success()
            cache.store(
                path,
                CachedCall(
                    scope=scope,
                    cache_key=cache_key,
                    call_index=index,
                    request_digest=request_digest,
                    kind="text",
                    text=text,
                    detail=None,
                    reported_model=response.model,
                    prompt_tokens=usage.prompt_tokens if usage else 0,
                    completion_tokens=usage.completion_tokens if usage else 0,
                ),
            )
            return text

        streak = cache.note_failure()
        if streak > MAXIMUM_CONSECUTIVE_FAILURES:
            raise LiveRunAborted(
                f"{streak} consecutive gateway failures; last: {last_error}"
            )
        raise last_error or ProviderError("provider call failed")

    return chat


def load_official_gsm8k(path: Path) -> tuple[tuple[Problem, ...], tuple[int, ...]]:
    """Ingest the official split, keeping upstream line numbers as source ids.

    ``gsm8k.load_gsm8k`` cannot be used: it aborts the whole file on the first
    row whose sealed answer carries a thousands separator, and the official
    test split has 14 of those. Grading semantics are left strictly canonical;
    those rows are declared out of the population instead.
    """
    problems: list[Problem] = []
    skipped: list[int] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            row = json.loads(line)
            try:
                answer = parse_source_answer(row["answer"])
            except Gsm8kError:
                skipped.append(line_number)
                continue
            problems.append(
                Problem(
                    record_id=SourceId(f"gsm8k-test-{line_number:04d}"),
                    question=row["question"].strip(),
                    answer=SourceAnswer(answer),
                )
            )
    return tuple(problems), tuple(skipped)


def select_candidates(problems: tuple[Problem, ...], count: int) -> tuple[Problem, ...]:
    """Seeded selection from the admissible pool, excluding the pilot sources.

    A single full shuffle, then a slice. ``random.sample`` is *not*
    prefix-stable across different sample sizes, so it cannot be used to carve
    disjoint pilot and main samples out of one seed.
    """
    ordered = [
        problem
        for problem in sorted(problems, key=_key)
        if str(problem.record_id) not in PILOT_SOURCE_IDS
    ]
    random.Random(SELECTION_SEED).shuffle(ordered)
    if count > len(ordered):
        raise ValueError("requested more candidates than the admissible pool holds")
    return tuple(sorted(ordered[:count], key=_key))


def _key(problem: Problem) -> str:
    return str(problem.record_id)


def construct(
    problems: tuple[Problem, ...],
    cache: ResponseCache,
    families_path: Path,
    receipts_path: Path,
    workers: int,
) -> tuple[dict[str, ScriptFamily], list[ConstructionReceipt]]:
    provider = HudGatewayProvider(CONSTRUCTION_MODEL)
    stored = _read_families(families_path)
    receipts = _read_receipts(receipts_path)
    lock = threading.Lock()
    pending = [
        problem for problem in problems if str(problem.record_id) not in receipts
    ]

    def build(problem: Problem) -> None:
        source_id = str(problem.record_id)
        chat = cached_chat(
            provider,
            cache,
            scope="construction",
            cache_key=(source_id,),
            temperature=CONSTRUCTION_TEMPERATURE,
            seed=CONSTRUCTION_SEED,
        )
        family: ScriptFamily | None = None
        try:
            family = build_script_family(
                problem,
                chat,
                seed=CONSTRUCTION_SEED,
                construction_model=CONSTRUCTION_MODEL,
                max_output_tokens=PER_TURN_OUTPUT_TOKENS,
            )
        except LiveRunAborted:
            raise
        except (ConstructionError, ProviderError, BudgetError) as error:
            receipt = ConstructionReceipt(
                source_id=problem.record_id,
                admitted=False,
                reason=f"{type(error).__name__}: {error}"[:400],
                turns=0,
                arguments=0,
            )
        else:
            arguments = len(family.source_intent.arguments)
            turns = len(family.evolved.turns)
            admitted = arguments <= MAXIMUM_ARGUMENTS
            receipt = ConstructionReceipt(
                source_id=problem.record_id,
                admitted=admitted,
                reason=(
                    "admitted"
                    if admitted
                    else f"argument_bound: {arguments} > {MAXIMUM_ARGUMENTS}"
                ),
                turns=turns,
                arguments=arguments,
            )
            if not admitted:
                family = None
        with lock:
            if family is not None:
                _append_family(families_path, source_id, family)
                stored[source_id] = family
            _append(receipts_path, receipt)
            receipts[source_id] = receipt
            if len(receipts) % 25 == 0:
                print(f"CONSTRUCTION {len(receipts)}/{len(problems)}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(build, pending))

    selected = {str(problem.record_id) for problem in problems}
    admitted_families = {
        source: family
        for source, family in stored.items()
        if source in selected and receipts[source].admitted
    }
    ordered = [receipts[str(problem.record_id)] for problem in problems]
    return admitted_families, ordered


def _append_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as output:
        output.write(data + b"\n")
        output.flush()
        os.fsync(output.fileno())


def _append(path: Path, value: StrictModel) -> None:
    _append_bytes(path, canonical_bytes(value))


def _append_family(path: Path, source_id: str, family: ScriptFamily) -> None:
    _append_bytes(
        path,
        json.dumps(
            {"source_id": source_id, "family": family.model_dump(mode="json")},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode(),
    )


def _read_families(path: Path) -> dict[str, ScriptFamily]:
    if not path.exists():
        return {}
    families: dict[str, ScriptFamily] = {}
    for line in path.read_bytes().splitlines():
        if not line:
            continue
        row = json.loads(line)
        # Must go through JSON validation, not model_validate on a dict:
        # StrictModel sets strict=True, under which a Python list will not
        # coerce to the declared tuple fields. Only the resume path hits this.
        families[row["source_id"]] = ScriptFamily.model_validate_json(
            json.dumps(row["family"])
        )
    return families


def _read_receipts(path: Path) -> dict[str, ConstructionReceipt]:
    if not path.exists():
        return {}
    return {
        str(receipt.source_id): receipt
        for line in path.read_bytes().splitlines()
        if line
        for receipt in (ConstructionReceipt.model_validate_json(line),)
    }


def _identity(source_id: str, arm: Arm, trial_index: int, seed: int) -> RunIdentity:
    digest = "0" * 64
    return RunIdentity(
        design_digest=digest,
        source_id=SourceId(source_id),
        source_digest=digest,
        model_config_digest=digest,
        trial_index=trial_index,
        trial_seed=seed,
        arm=arm,
        arm_config_digest=digest,
    )


def warm(
    families: dict[str, ScriptFamily],
    cache: ResponseCache,
    trial_seeds: tuple[int, ...],
    workers: int,
) -> int:
    provider = HudGatewayProvider(MODEL)
    episodes = [
        (source_id, family, trial_index, seed, script.arm, script)
        for source_id, family in sorted(families.items())
        for trial_index, seed in enumerate(trial_seeds)
        for script in family.scripts
    ]
    errors = 0
    lock = threading.Lock()
    done = {"count": 0}

    def execute(item) -> None:
        nonlocal errors
        source_id, _family, trial_index, seed, arm, script = item
        chat = cached_chat(
            provider,
            cache,
            scope="episode",
            cache_key=(source_id, f"trial-{trial_index}", arm),
            temperature=TEMPERATURE,
            seed=seed,
        )
        try:
            run_script(
                script,
                chat,
                _identity(source_id, arm, trial_index, seed),
                agent_model=MODEL,
                system_prompt=SYSTEM_PROMPT,
            )
        except LiveRunAborted:
            raise
        except Exception:
            with lock:
                errors += 1
        with lock:
            done["count"] += 1
            if done["count"] % 50 == 0:
                print(f"WARM {done['count']}/{len(episodes)}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(execute, episodes))
    return errors


def evidence(
    families: dict[str, ScriptFamily],
    cache: ResponseCache,
    trial_seeds: tuple[int, ...],
    output_path: Path,
    preregistration_digest: str,
) -> None:
    provider = HudGatewayProvider(MODEL)
    index_by_seed = {seed: index for index, seed in enumerate(trial_seeds)}

    def factory(source_id: SourceId, arm: Arm, trial_seed: int):
        return cached_chat(
            provider,
            cache,
            scope="episode",
            cache_key=(
                str(source_id),
                f"trial-{index_by_seed[trial_seed]}",
                arm,
            ),
            temperature=TEMPERATURE,
            seed=trial_seed,
        )

    run_experiment(
        tuple(families[key] for key in sorted(families)),
        factory,
        trial_seeds=trial_seeds,
        agent_model=MODEL,
        model_config={
            "construction_model": CONSTRUCTION_MODEL,
            "construction_temperature": CONSTRUCTION_TEMPERATURE,
            "max_output_tokens_per_turn": PER_TURN_OUTPUT_TOKENS,
            "preregistration_digest": preregistration_digest,
            "provider_endpoint": HUD_GATEWAY_ENDPOINT,
            "seed_field_sent": True,
            "seed_honored_by_provider": False,
            "system_prompt_digest": canonical_digest(SYSTEM_PROMPT),
            "temperature": TEMPERATURE,
        },
        threshold=0.0,
        output_path=output_path,
        system_prompt=SYSTEM_PROMPT,
    )


def spend(cache: ResponseCache) -> dict[str, object]:
    entries = cache.entries()
    by_scope: dict[str, dict[str, float]] = {}
    for entry in entries:
        bucket = by_scope.setdefault(
            entry.scope,
            {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "usd": 0.0},
        )
        bucket["calls"] += 1
        bucket["prompt_tokens"] += entry.prompt_tokens
        bucket["completion_tokens"] += entry.completion_tokens
        bucket["usd"] += entry.cost_usd
    return {
        "by_scope": by_scope,
        "total_usd": sum(bucket["usd"] for bucket in by_scope.values()),
        "total_calls": len(entries),
        "reported_models": sorted({entry.reported_model for entry in entries}),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--candidates", type=int, required=True)
    parser.add_argument("--trials", type=int, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--warm-passes", type=int, default=3)
    parser.add_argument("--preregistration", type=Path, default=None)
    arguments = parser.parse_args()

    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is required")

    label = arguments.label
    cache = ResponseCache(WORK / "response-cache" / label)
    families_path = WORK / f"{label}-families.jsonl"
    receipts_path = EVIDENCE / f"{label}-construction.jsonl"
    evidence_path = EVIDENCE / f"{label}-evidence.jsonl"
    spend_path = EVIDENCE / f"{label}-spend.json"

    preregistration_digest = ""
    if arguments.preregistration is not None:
        preregistration_digest = canonical_digest(
            json.loads(arguments.preregistration.read_text())
        )
        print(f"PREREGISTRATION digest={preregistration_digest}", flush=True)

    problems, skipped = load_official_gsm8k(DATASET)
    print(f"INGEST admissible={len(problems)} skipped={len(skipped)}", flush=True)
    candidates = select_candidates(problems, arguments.candidates)
    print(f"CANDIDATES {len(candidates)}", flush=True)

    trial_seeds = tuple(int(f"2026080{index + 1}") for index in range(arguments.trials))

    families, receipts = construct(
        candidates,
        cache,
        families_path,
        receipts_path,
        arguments.workers,
    )
    admitted = len([item for item in receipts if item.admitted])
    print(f"ADMITTED {admitted}/{len(receipts)}", flush=True)
    if not families:
        raise RuntimeError("no admitted families")

    for index in range(arguments.warm_passes):
        errors = warm(families, cache, trial_seeds, arguments.workers)
        print(f"WARM_PASS {index} errors={errors}", flush=True)
        if not errors:
            break

    if evidence_path.exists():
        print("EVIDENCE already written", flush=True)
    else:
        evidence(families, cache, trial_seeds, evidence_path, preregistration_digest)
        print(f"EVIDENCE written {evidence_path}", flush=True)

    receipt = spend(cache)
    atomic_write(
        spend_path,
        json.dumps(receipt, indent=2, sort_keys=True).encode() + b"\n",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
