"""Predeclared comparison contracts and exports; no execution entry point."""
import csv
from decimal import Decimal
from io import StringIO
from pathlib import Path
import statistics
import tomllib

from ..cli.data import integer, json_bytes, keys, mapping, plain, sequence, string
from ..cli.resolve import load_manifest, tree
from ..codec import content_ref
from ..errors import VerificationError
from ..store import RunReader
from ..store.cas import atomic_file, durable_directory
from .history import history
from .snapshot import snapshot


def comparison_spec(source: str) -> dict[str, object]:
    spec = mapping(tomllib.loads(source))
    keys(spec, "strictness allowed_differences horizon pairing metric exclusions stopping selection uncertainty")
    if spec["strictness"] not in {"matched", "descriptive"} or spec["pairing"] != "workload_seed":
        raise VerificationError("unsupported comparison strictness or pairing")
    if (spec["metric"] != "cumulative_successes" or spec["exclusions"] != []
            or spec["stopping"] != "budget-or-horizon" or spec["uncertainty"] != "paired-normal-95"
            or spec["selection"] != "final_valid_active_actor_from_every_trajectory"):
        raise VerificationError("unsupported analysis rule; do not silently change the declared estimand")
    integer(spec["horizon"], 1)
    allowed = [string(v) for v in sequence(spec["allowed_differences"])]
    if any(v not in {"run.editable", "policy.package", "policy.parameters", "pins.initial_bundle"} for v in allowed):
        raise VerificationError("interventions must name supported leaf conditions")
    return spec


def conditions(read: RunReader) -> dict[str, object]:
    read = snapshot(read)
    binding = read.verify().binding
    assert binding is not None
    manifest = load_manifest(read.objects, binding.resolved_manifest)
    config = mapping(plain(manifest.configuration))
    config.pop("telemetry")  # Inspection profile is not a scientific intervention.
    result: dict[str, object] = {}
    def flatten(value: object, prefix: str) -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                flatten(v, prefix + "." + str(k) if prefix else str(k))
        else:
            result[prefix] = value
    flatten(config, "")
    # Bundle identity is explained by exact file content, not scope-dependent
    # FileVersion digests. An allowed controller change never hides actor edits.
    for label, ref in (("pins.initial_bundle", manifest.configuration.pins.initial_bundle),
                       ("policy.package", manifest.configuration.policy.package)):
        result.pop(label, None)
        for path, data in tree(read.objects, ref).items():
            result[label + "." + path] = content_ref(data).digest
    result["closure.dependencies"] = plain(manifest.closure.dependency_artifacts)
    result["closure.models"] = plain(manifest.closure.model_resolutions)
    result["closure.sandbox"] = manifest.closure.timeout_and_retry_settings.digest
    return result


def compare(left: list[RunReader], right: list[RunReader], spec: dict[str, object]) -> dict[str, object]:
    if not left or len(left) != len(right):
        raise VerificationError("comparison requires declared paired repetitions")
    differences: list[dict[str, object]] = []
    reports: list[dict[str, object]] = []
    deltas: list[float] = []
    incomplete = 0
    allowed = [string(v) for v in sequence(spec["allowed_differences"])]
    seeds: set[int] = set()
    for a, b in zip(left, right, strict=True):
        a, b = snapshot(a), snapshot(b)
        ca, cb = conditions(a), conditions(b)
        bound_a, bound_b = a.verify().binding, b.verify().binding
        assert bound_a is not None and bound_b is not None
        if spec["strictness"] == "matched" and (not set(allowed) <= set(bound_a.comparison_contract.allowed_differences)
                or not set(allowed) <= set(bound_b.comparison_contract.allowed_differences)):
            raise VerificationError("comparison intervention was not predeclared in both runs")
        pair_diff = [{"condition": k, "a": ca.get(k), "b": cb.get(k),
                      "declared": any(k == v or k.startswith(v + ".") for v in allowed)}
                     for k in sorted(ca.keys() | cb.keys()) if ca.get(k) != cb.get(k)]
        differences.extend({"a_run": a.authority.run_id, "b_run": b.authority.run_id, **d} for d in pair_diff)
        if spec["strictness"] == "matched" and any(not d["declared"] for d in pair_diff):
            raise VerificationError("unmatched conditions: " + json_bytes(pair_diff).decode())
        seed = integer(ca["seeds.workload"])
        if spec["strictness"] == "matched" and seed in seeds:
            raise VerificationError("duplicate workload seed is not an independent paired repetition")
        seeds.add(seed)
        ha, hb = history(a), history(b)
        for h in (ha, hb):
            if spec["strictness"] == "matched" and mapping(h["coverage"])["planned"] != spec["horizon"]:
                raise VerificationError("declared comparison horizon differs from run")
            reports.append(h)
        missing = any(integer(mapping(h["coverage"])["unresolved"]) + integer(mapping(h["coverage"])["failed"]) > 0 for h in (ha, hb))
        if missing:
            incomplete += 1
        else:
            deltas.append(float(Decimal(string(mapping(hb["performance"])["cumulative_successes"]))
                                - Decimal(string(mapping(ha["performance"])["cumulative_successes"]))))
    interval: list[float] | None = None
    if spec["strictness"] == "matched" and len(deltas) >= 2:
        mean = statistics.mean(deltas)
        margin = 1.96 * statistics.stdev(deltas) / len(deltas) ** 0.5
        interval = [mean - margin, mean + margin]
    return {"schema": "strive.comparison/1", "comparison_strength": spec["strictness"], "analysis_plan": spec,
        "differences": differences, "runs": reports,
        "uncertainty": {"unit": "paired trajectory", "planned_pairs": len(left), "complete_pairs": len(deltas),
            "incomplete_pairs": incomplete, "interval": interval,
            "mean_complete_pair_delta": statistics.mean(deltas) if deltas and spec["strictness"] == "matched" else None,
            "method": "predeclared normal approximation, 95%; complete pairs only; small-sample limitations apply",
            "missing_outcomes": "not absorbed by intervals; per-run bounds and coverage are reported separately"},
        "claim": "descriptive outcomes only" if spec["strictness"] == "descriptive" else
                 "matched comparison; no improvement claim with missing pairs or insufficient independent repetitions"}


def export(report: dict[str, object], destination: Path) -> tuple[Path, Path, Path]:
    durable_directory(destination)
    json_path, csv_path, md_path = (destination / name for name in ("report.json", "report.csv", "report.md"))
    atomic_file(json_path, json_bytes(report), replace=True)
    stream = StringIO()
    columns = ["run", "status", "planned", "admitted", "completed", "failed", "excluded", "unresolved",
               "episode", "value", "event", "evidence", "cumulative_nanodollars"]
    writer = csv.DictWriter(stream, fieldnames=columns)
    writer.writeheader()
    lines = ["# Research comparison", "", str(report.get("claim", "Journal-derived research outcomes")), "",
             "Execution integrity / measurement provenance, feedback exposure, and comparison strength are separate labels.", "",
             "| Run | Status | Planned | Admitted | Completed | Failed | Excluded | Unresolved | Successes |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    details: list[str] = []
    for raw in sequence(report["runs"]):
        h = mapping(raw)
        coverage = mapping(h["coverage"])
        base = {"run": h["run"], "status": h["status"], **{k: coverage[k] for k in columns[2:8]}}
        rows = sequence(h["official_measurements"])
        for item in rows or [{}]:
            row = mapping(item)
            writer.writerow({**base, **{k: row.get(k, "") for k in columns[8:]}})
        successes = mapping(h["performance"])["cumulative_successes"]
        lines.append("| " + " | ".join(str(base[k]) for k in columns[:8]) + f" | {successes} |")
        details += ["", f"## {h['run']}", "", "```json", json_bytes({k: h[k] for k in
            ("inspection", "labels", "performance", "retention", "expenditure", "candidate_claims", "judge_assessments") if k in h}).decode(), "```", "",
            "Official evidence: " + ", ".join(str(mapping(r)["event"]) for r in rows)]
    lines += details + ["", "Analysis: " + json_bytes(report.get("uncertainty", {})).decode()]
    totals = {k: v for k, v in report.items() if k.endswith("expenditure") or k == "allocation"}
    if totals:
        lines += ["", "Campaign accounting:", "", "```json", json_bytes(totals).decode(), "```"]
    atomic_file(csv_path, stream.getvalue().encode(), replace=True)
    atomic_file(md_path, ("\n".join(lines) + "\n").encode(), replace=True)
    return md_path, json_path, csv_path
