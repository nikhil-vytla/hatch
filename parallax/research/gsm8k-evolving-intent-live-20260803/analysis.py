"""Validate and summarise GSM8K three-arm live evidence.

Deliberately standalone. It re-implements the evidence linkage checks and
computes its own statistics instead of calling ``parallax.report``, because
that module's ``threshold`` / ``powered`` / ``action`` machinery is being
removed on a separate branch and this study reports intervals as facts rather
than returning a verdict.

Linkage checked here, all of it already required by the evidence schema:

- exactly one manifest;
- every family row carries the manifest design digest and its scheduled source
  digest, and each of its three arm scripts re-digests to the manifest's
  recorded arm-config digest;
- every run row is a scheduled unit, with matching seed and matching design,
  model-config, source, and arm-config digests;
- no duplicate and no missing (source, trial, arm) row.

Because the preregistration digest is one of the fields hashed into
``model_config_digest``, and ``model_config_digest`` is hashed into
``design_digest``, a run row cannot validate against a manifest built from a
different preregistration.
"""

from __future__ import annotations

import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

from parallax.canonical import canonical_digest
from parallax.outcome import RunFailure, Verification
from parallax.runner import (
    EvidenceRecord,
    FamilyRecord,
    ManifestRecord,
    RunRecord,
    read_run_jsonl,
)

BOOTSTRAP_RESAMPLES = 20000
BOOTSTRAP_SEED = 20260803


def validate(
    records: tuple[EvidenceRecord, ...],
) -> tuple[
    ManifestRecord,
    dict[str, FamilyRecord],
    dict[tuple[str, int, str], RunRecord],
]:
    manifests = [item for item in records if isinstance(item, ManifestRecord)]
    families = [item for item in records if isinstance(item, FamilyRecord)]
    runs = [item for item in records if isinstance(item, RunRecord)]
    if len(manifests) != 1:
        raise ValueError("evidence must contain exactly one manifest")
    manifest = manifests[0]
    units = {
        (str(unit.source_id), int(unit.trial_index)): (
            unit.source_digest,
            unit.trial_seed,
        )
        for unit in manifest.units
    }
    arm_digests = {
        (str(item.source_id), item.arm): item.digest
        for item in manifest.arm_config_digests
    }
    source_digests = {source: value[0] for (source, _), value in units.items()}

    indexed_families: dict[str, FamilyRecord] = {}
    for row in families:
        source = str(row.source_id)
        if source in indexed_families:
            raise ValueError(f"duplicate_family: {source}")
        if row.design_digest != manifest.design_digest:
            raise ValueError(f"family_design_drift: {source}")
        if row.source_digest != source_digests.get(source):
            raise ValueError(f"family_source_drift: {source}")
        for arm, script in row.scripts.items():
            actual = canonical_digest(
                {"source_id": source, "script": script.model_dump(mode="json")}
            )
            if actual != arm_digests[(source, arm)]:
                raise ValueError(f"family_arm_digest_drift: {source} {arm}")
        indexed_families[source] = row
    if set(indexed_families) != set(source_digests):
        raise ValueError("family records differ from scheduled sources")

    indexed: dict[tuple[str, int, str], RunRecord] = {}
    for row in runs:
        unit = (str(row.source_id), int(row.trial_index))
        if unit not in units:
            raise ValueError(f"extra_unit: {unit!r}")
        source_digest, seed = units[unit]
        if row.trial_seed != seed:
            raise ValueError(f"seed_drift: {unit!r}")
        checks = {
            "design": row.design_digest != manifest.design_digest,
            "model_config": row.model_config_digest != manifest.model_config_digest,
            "source": row.source_digest != source_digest,
            "arm_config": (
                row.arm_config_digest != arm_digests[(str(row.source_id), row.arm)]
            ),
        }
        if drift := next((name for name, bad in checks.items() if bad), None):
            raise ValueError(f"{drift}_drift: {unit!r} arm={row.arm}")
        key = (*unit, row.arm)
        if key in indexed:
            raise ValueError(f"duplicate_unit_arm: {key!r}")
        indexed[key] = row
    # Arms come from the manifest, never from a hardcoded arm tuple, so this
    # validates two-arm and three-arm evidence alike.
    manifest_arms = sorted({arm for _, arm in arm_digests})
    expected = {
        (source, trial, arm) for source, trial in units for arm in manifest_arms
    }
    if missing := expected - set(indexed):
        raise ValueError(f"missing_scheduled_rows: {len(missing)}")
    return manifest, indexed_families, indexed


def _score(record: RunRecord) -> int | None:
    outcome = record.outcome
    if isinstance(outcome, Verification):
        return int(outcome.verdict.value == "pass")
    return None


def _cluster_interval(
    values: list[float],
    *,
    resamples: int = BOOTSTRAP_RESAMPLES,
) -> dict[str, float | None]:
    """Percentile bootstrap over source clusters, plus a normal-approx SE.

    Sources are the independent unit, so resampling is over sources.
    """
    count = len(values)
    if count == 0:
        return {
            "estimate": None,
            "clusters": 0,
            "standard_error": None,
            "lower": None,
            "upper": None,
            "normal_lower": None,
            "normal_upper": None,
        }
    estimate = sum(values) / count
    if count == 1:
        return {
            "estimate": estimate,
            "clusters": 1,
            "standard_error": None,
            "lower": None,
            "upper": None,
            "normal_lower": None,
            "normal_upper": None,
        }
    variance = sum((value - estimate) ** 2 for value in values) / (count - 1)
    standard_error = math.sqrt(variance / count)
    rng = random.Random(BOOTSTRAP_SEED)
    means: list[float] = []
    for _ in range(resamples):
        total = 0.0
        for _ in range(count):
            total += values[rng.randrange(count)]
        means.append(total / count)
    means.sort()
    lower = means[int(0.025 * (resamples - 1))]
    upper = means[math.ceil(0.975 * (resamples - 1))]
    return {
        "estimate": estimate,
        "clusters": count,
        "standard_error": standard_error,
        "lower": lower,
        "upper": upper,
        "normal_lower": estimate - 1.959963984540054 * standard_error,
        "normal_upper": estimate + 1.959963984540054 * standard_error,
    }


def arm_rates(
    rows: dict[tuple[str, int, str], RunRecord],
    families: dict[str, FamilyRecord],
    arm: str,
) -> dict:
    verdicts: Counter[str] = Counter()
    failures: Counter[str] = Counter()
    per_source: dict[str, list[int]] = defaultdict(list)
    turns_delivered = 0
    turns_scheduled = 0
    complete_episodes = 0
    total = 0
    for (source, _, value), row in rows.items():
        if value != arm:
            continue
        total += 1
        outcome = row.outcome
        if isinstance(outcome, Verification):
            verdicts[outcome.verdict.value] += 1
            per_source[source].append(int(outcome.verdict.value == "pass"))
        elif isinstance(outcome, RunFailure):
            failures[outcome.failure_kind] += 1
        scheduled = len(families[source].scripts[arm].turns)
        turns_delivered += row.usage.completed_turns
        turns_scheduled += scheduled
        complete_episodes += int(row.usage.completed_turns == scheduled)
    verified = sum(verdicts.values())
    # Sorted by source id, never insertion order: the bootstrap resamples by
    # index, so an order-dependent list makes the interval depend on the order
    # rows happen to appear in the evidence file.
    source_means = [
        sum(values) / len(values) for _, values in sorted(per_source.items())
    ]
    return {
        "scheduled": total,
        "verification_outcomes": verified,
        "pass": verdicts["pass"],
        "wrong": verdicts["wrong"],
        "invalid": verdicts["invalid"],
        "run_failures": sum(failures.values()),
        "failure_kinds": dict(sorted(failures.items())),
        "pass_rate_pooled": verdicts["pass"] / verified if verified else None,
        "invalid_rate_pooled": verdicts["invalid"] / verified if verified else None,
        "accuracy_clustered": _cluster_interval(source_means),
        "assistant_turns_delivered": turns_delivered,
        "turns_scheduled": turns_scheduled,
        "episodes_with_every_turn_answered": complete_episodes,
    }


def contrast(
    rows: dict[tuple[str, int, str], RunRecord],
    treatment: str,
    control: str,
) -> dict:
    per_source: dict[str, list[int]] = defaultdict(list)
    bounds: dict[str, list[tuple[float, float]]] = defaultdict(list)
    dropped = 0
    units = sorted({(source, trial) for source, trial, _ in rows})
    for source, trial in units:
        treated = _score(rows[(source, trial, treatment)])
        controlled = _score(rows[(source, trial, control)])
        if treated is not None and controlled is not None:
            per_source[source].append(treated - controlled)
            bounds[source].append((float(treated - controlled),) * 2)
            continue
        dropped += 1
        if treated is None and controlled is None:
            bounds[source].append((-1.0, 1.0))
        elif treated is None:
            bounds[source].append((float(-controlled), float(1 - controlled)))
        else:
            bounds[source].append((float(treated - 1), float(treated)))
    complete = [
        sum(values) / len(values) for _, values in sorted(per_source.items()) if values
    ]
    source_bounds = [
        (
            sum(item[0] for item in values) / len(values),
            sum(item[1] for item in values) / len(values),
        )
        for _, values in sorted(bounds.items())
    ]
    identification = {
        "lower": (
            sum(item[0] for item in source_bounds) / len(source_bounds)
            if source_bounds
            else None
        ),
        "upper": (
            sum(item[1] for item in source_bounds) / len(source_bounds)
            if source_bounds
            else None
        ),
    }
    return {
        "treatment": treatment,
        "control": control,
        "complete_case": _cluster_interval(complete),
        "pairs_dropped_to_run_failure": dropped,
        "identification_bounds_over_run_failures": identification,
    }


def summarize(evidence_path: Path) -> dict:
    records = read_run_jsonl(evidence_path)
    manifest, families, rows = validate(records)
    sources = sorted({source for source, _, _ in rows})
    trials = sorted({trial for _, trial, _ in rows})
    arms = sorted({arm for _, _, arm in rows})
    pairs = [
        ("evolved", "static"),
        ("evolved", "matched"),
        ("matched", "static"),
    ]
    contrasts = {
        f"{treatment}_minus_{control}": contrast(rows, treatment, control)
        for treatment, control in pairs
        if treatment in arms and control in arms
    }
    return {
        "linkage": {
            "design_digest": manifest.design_digest,
            "model_config_digest": manifest.model_config_digest,
            "validated": True,
        },
        "population": {
            "source_clusters": len(sources),
            "trials_per_source": len(trials),
            "trial_units": len(sources) * len(trials),
            "scheduled_rows": len(rows),
        },
        "construction": {
            "mean_extracted_arguments": (
                sum(len(row.source_intent.arguments) for row in families.values())
                / len(families)
            ),
            "mean_evolved_turns": (
                sum(len(row.scripts["evolved"].turns) for row in families.values())
                / len(families)
            ),
            "rejected_construction_attempts": sum(
                sum(1 for attempt in row.construction_attempts if not attempt.accepted)
                for row in families.values()
            ),
            "total_construction_attempts": sum(
                len(row.construction_attempts) for row in families.values()
            ),
        },
        "arms_executed": arms,
        "arm_rates": {arm: arm_rates(rows, families, arm) for arm in arms},
        "primary_contrast": "evolved_minus_static",
        "secondary_contrasts": [
            name for name in contrasts if name != "evolved_minus_static"
        ],
        "contrasts": contrasts,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    arguments = parser.parse_args()
    report = summarize(arguments.evidence)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if arguments.out is not None:
        arguments.out.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
