from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import assert_never

from .canonical import atomic_write, canonical_digest
from .evolving_intent import Arm
from .outcome import Outcome, RunFailure, Verification
from .paired import paired_bounds
from .runner import (
    ARMS,
    EvidenceRecord,
    FamilyRecord,
    ManifestRecord,
    RunRecord,
    read_run_jsonl,
)
from .types import (
    ArmConfigDigest,
    SourceDigest,
    SourceId,
    TrialIndex,
    TrialSeed,
)


def _manifest(
    record: ManifestRecord,
) -> tuple[
    dict[tuple[SourceId, TrialIndex], tuple[SourceDigest, TrialSeed]],
    dict[tuple[SourceId, Arm], ArmConfigDigest],
]:
    units = {
        (item.source_id, item.trial_index): (
            item.source_digest,
            item.trial_seed,
        )
        for item in record.units
    }
    arm_digests = {
        (item.source_id, item.arm): item.digest for item in record.arm_config_digests
    }
    return units, arm_digests


def _validated(
    records: tuple[EvidenceRecord, ...],
) -> tuple[dict[tuple[SourceId, TrialIndex, str], RunRecord], int]:
    manifests: list[ManifestRecord] = []
    families: list[FamilyRecord] = []
    runs: list[RunRecord] = []
    for record in records:
        if isinstance(record, ManifestRecord):
            manifests.append(record)
        elif isinstance(record, FamilyRecord):
            families.append(record)
        elif isinstance(record, RunRecord):
            runs.append(record)
        else:
            assert_never(record)
    if len(manifests) != 1:
        raise ValueError("evidence must contain exactly one manifest")
    manifest = manifests[0]
    units, arm_digests = _manifest(manifest)
    source_digests = {source: value[0] for (source, _), value in units.items()}
    seen_sources: set[SourceId] = set()
    for row in families:
        source = row.source_id
        if source in seen_sources:
            raise ValueError(f"duplicate_family: {source}")
        if (
            row.design_digest != manifest.design_digest
            or row.source_digest != source_digests.get(source)
        ):
            raise ValueError(f"family_identity_drift: {source}")
        for arm, script in row.scripts.items():
            actual = canonical_digest(
                {"source_id": source, "script": script.model_dump(mode="json")}
            )
            if actual != arm_digests[(source, arm)]:
                raise ValueError(f"family_arm_digest_drift: {source}, arm={arm}")
        seen_sources.add(source)
    if seen_sources != set(source_digests):
        raise ValueError("family records differ from scheduled sources")
    indexed: dict[tuple[SourceId, TrialIndex, str], RunRecord] = {}
    for row in runs:
        unit = (row.source_id, row.trial_index)
        if unit not in units:
            raise ValueError(f"extra_unit: {unit!r}")
        source_digest, expected_seed = units[unit]
        if row.trial_seed != expected_seed:
            raise ValueError(
                f"seed_drift: key={unit!r}, expected={expected_seed}, "
                f"actual={row.trial_seed}"
            )
        drifts = {
            "design": row.design_digest != manifest.design_digest,
            "config": row.model_config_digest != manifest.model_config_digest,
            "source": row.source_digest != source_digest,
            "arm_config": row.arm_config_digest
            != arm_digests[(row.source_id, row.arm)],
        }
        if drift := next((name for name, changed in drifts.items() if changed), None):
            raise ValueError(f"{drift}_drift: {unit!r}, arm={row.arm}")
        key = (row.source_id, row.trial_index, row.arm)
        if key in indexed:
            raise ValueError(f"duplicate_unit_arm: {key!r}")
        indexed[key] = row
    expected = {(source, trial, arm) for source, trial in units for arm in ARMS}
    if missing := expected - set(indexed):
        raise ValueError(f"missing_scheduled_rows: {sorted(missing)!r}")
    return indexed, len(seen_sources)


def _rates(
    indexed: dict[tuple[SourceId, TrialIndex, str], RunRecord],
    arm: str,
) -> dict[str, object]:
    verdicts: Counter[str] = Counter()
    failures: Counter[str] = Counter()
    outcomes = [row.outcome for (*_, value), row in indexed.items() if value == arm]
    for outcome in outcomes:
        if isinstance(outcome, Verification):
            verdicts[outcome.verdict.value] += 1
        elif isinstance(outcome, RunFailure):
            failures[outcome.failure_kind] += 1
        else:
            assert_never(outcome)
    verified, total = sum(verdicts.values()), len(outcomes)

    def rate(count: int, denominator: int) -> float | None:
        return count / denominator if denominator else None

    return {
        "scheduled": total,
        "verification_outcomes": verified,
        "pass": verdicts["pass"],
        "wrong": verdicts["wrong"],
        "invalid": verdicts["invalid"],
        "run_failures": sum(failures.values()),
        "failure_counts": dict(sorted(failures.items())),
        "pass_rate": rate(verdicts["pass"], verified),
        "wrong_rate": rate(verdicts["wrong"], verified),
        "invalid_rate": rate(verdicts["invalid"], verified),
        "model_failure_rate": rate(verdicts["wrong"] + verdicts["invalid"], verified),
        "run_failure_rate": rate(sum(failures.values()), total),
        "operational_pass_rate": rate(verdicts["pass"], total),
    }


def _y(outcome: Outcome) -> int | None:
    if isinstance(outcome, Verification):
        return int(outcome.verdict.value == "pass")
    if isinstance(outcome, RunFailure):
        return None
    assert_never(outcome)


def _failure(outcome: Outcome) -> RunFailure:
    if isinstance(outcome, RunFailure):
        return outcome
    if isinstance(outcome, Verification):
        raise AssertionError("verified outcome cannot have an unobserved score")
    assert_never(outcome)


def build_report(records: tuple[EvidenceRecord, ...]) -> dict[str, object]:
    rows, source_count = _validated(records)
    units = sorted({(source, trial) for source, trial, _ in rows})
    pairs: dict[SourceId, list[tuple[int | None, int | None]]] = defaultdict(list)
    missing: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    for source, trial in units:
        matched = rows[(source, trial, "matched")].outcome
        evolved = rows[(source, trial, "evolved")].outcome
        matched_y, evolved_y = _y(matched), _y(evolved)
        pairs[source].append((evolved_y, matched_y))
        if matched_y is not None and evolved_y is not None:
            continue
        if matched_y is not None:
            missing["evolved_failure"] += 1
            reasons[f"evolved:{_failure(evolved).failure_kind}"] += 1
        elif evolved_y is not None:
            missing["matched_failure"] += 1
            reasons[f"matched:{_failure(matched).failure_kind}"] += 1
        else:
            missing["both_failure"] += 1
            reasons[f"matched:{_failure(matched).failure_kind}"] += 1
            reasons[f"evolved:{_failure(evolved).failure_kind}"] += 1
    bounds = paired_bounds(pairs, estimand="evolved_minus_matched_pass_rate")
    return {
        "population": {
            "source_clusters": source_count,
            "trial_units": len(units),
            "scheduled_rows": len(rows),
        },
        "arm_rates": {arm: _rates(rows, arm) for arm in ARMS},
        "paired_count": bounds.paired_complete,
        "difference": bounds.point_delta_complete_pairs,
        "identification_bounds": {
            "lower": bounds.identification_lower,
            "upper": bounds.identification_upper,
        },
        "interval": {
            "confidence": 0.95,
            "method": "source_clustered_hoeffding",
            "epsilon": bounds.epsilon,
            "lower": bounds.interval_lower,
            "minimum_detectable_effect": bounds.minimum_detectable_effect,
            "upper": bounds.interval_upper,
        },
        "missing_pairs": {
            **{
                name: missing[name]
                for name in (
                    "evolved_failure",
                    "matched_failure",
                    "both_failure",
                )
            },
            "failure_reasons": dict(sorted(reasons.items())),
        },
    }


def report_from_jsonl(evidence_path: Path, report_path: Path) -> dict[str, object]:
    report = build_report(read_run_jsonl(evidence_path))
    data = (
        json.dumps(
            report,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
        + b"\n"
    )
    atomic_write(report_path, data)
    return report
