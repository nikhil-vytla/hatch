#!/usr/bin/env python3
"""Independently verify saved Smol comparison evidence without loading models."""
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROADMAP = HERE.parents[2]
LAB = ROADMAP.parent
TRAINING = ROADMAP / "training"
CACHE = LAB / ".cache/typed-study-v1"
LOCATION = CACHE / "smol"
SPLITS = ("validation", "test", "transfer")
UNITS = ("CPU_ONLY", "ALL")
FIELDS = {"id", "split", "values", "status", "mlxProbabilities", "coremlProbabilities",
          "maxProbabilityDelta", "argmaxAgreement"}


def sha(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def document(path):
    return json.loads(path.read_text())


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def require(value, message):
    if not value:
        raise ValueError(message)


def aggregate(items):
    supported = [row for row in items if row["status"] == "ok"]
    deltas = [max(abs(a - b) for a, b in zip(row["mlxProbabilities"], row["coremlProbabilities"]))
              for row in supported]
    agreements = [max(range(len(row["values"])), key=row["mlxProbabilities"].__getitem__) ==
                  max(range(len(row["values"])), key=row["coremlProbabilities"].__getitem__)
                  for row in supported]
    return {"rows": len(items), "supported": len(supported), "coverage": len(supported) / len(items),
            "argmaxAgreement": sum(agreements) / len(agreements), "maxProbabilityDelta": max(deltas)}


def main():
    report_path = TRAINING / "export-smol-17.json"
    report = document(report_path)
    original_report_sha = sha(report_path)
    provenance = report["provenance"]
    corpus = document(TRAINING / "corpus-manifest.json")
    models = document(TRAINING / "models-manifest.json")
    checkpoints = document(TRAINING / "checkpoints/manifest.json")["files"]
    require(report["model"] == "smol" and report["seed"] == 17 and report["status"] == "complete", "Export identity/status mismatch")
    source_hashes = {}
    for field, path in {
        "protocolSha256": TRAINING / "PROTOCOL.md",
        "corpusSha256": TRAINING / "corpus-manifest.json",
        "modelFilesSha256": TRAINING / "models-manifest.json",
        "featureManifestSha256": LOCATION / "feature-manifest.json",
    }.items():
        source_hashes[field] = sha(path)
        require(source_hashes[field] == provenance[field], "Provenance mismatch: " + field)
    require(corpus["protocolSha256"] == source_hashes["protocolSha256"], "Corpus protocol mismatch")
    require(corpus["sourcesSha256"] == sha(TRAINING / "sources.json"), "Source manifest hash mismatch")
    require(provenance["revision"] == models["smol"]["revision"], "Pinned revision mismatch")
    features = document(LOCATION / "feature-manifest.json")
    require(features["status"] == "complete" and features["model"] == "smol", "Feature manifest status/identity mismatch")
    require(features["revision"] == provenance["revision"] and features["corpusSha256"] == source_hashes["corpusSha256"]
            and features["modelFilesSha256"] == source_hashes["modelFilesSha256"], "Feature input identity mismatch")
    feature_checks = {}
    for split, expected in features["splits"].items():
        for suffix, key in (("json", "metadataSha256"), ("npz", "arraysSha256")):
            filename = split + "." + suffix
            feature_checks[filename] = sha(LOCATION / filename)
            require(feature_checks[filename] == expected[key], "Feature bytes changed: " + filename)
    readout_checks = {}
    for seed in (17, 29, 43):
        retained = TRAINING / "checkpoints" / f"smol-{seed}.safetensors"
        value = sha(LOCATION / f"readout-{seed}.safetensors")
        require(value == provenance["readoutSha256"][str(seed)] == sha(retained) == checkpoints[retained.name]["sha256"], "Readout mismatch")
        readout_checks[str(seed)] = value
    prediction_checks = {}
    for filename, expected in provenance["predictionSha256"].items():
        prediction_checks[filename] = sha(LOCATION / filename)
        require(prediction_checks[filename] == expected, "MLX prediction bytes changed: " + filename)

    expected_rows = []
    corpus_checks = {}
    for split in SPLITS:
        raw_corpus = CACHE / (split + ".jsonl")
        corpus_checks[split] = sha(raw_corpus)
        require(corpus_checks[split] == corpus["splits"][split]["sha256"], "Frozen split mismatch")
        original = rows(LOCATION / f"predictions-17-{split}.jsonl")
        ids = [row["id"] for row in original]
        require(ids == [row["id"] for row in corpus["splits"][split]["rows"]], "Split order/identity mismatch")
        require(len(ids) == len(set(ids)) == corpus["splits"][split]["count"], "Split count/uniqueness mismatch")
        expected_rows.extend((split, row) for row in original)

    comparisons, public_hashes, raw_coreml_hashes = {}, {}, {}
    for units in UNITS:
        artifact = report["decisionComparisonArtifacts"][units]
        public_path = TRAINING / artifact["file"]
        public_hashes[units] = sha(public_path)
        require(public_hashes[units] == artifact["sha256"], "Public comparison hash mismatch")
        public_rows = rows(public_path)
        raw_path = LOCATION / f"coreml-17-{report['precision']}-{units}.jsonl"
        raw_coreml_hashes[units] = sha(raw_path)
        require(raw_coreml_hashes[units] == report["evaluations"][units]["predictionsSha256"], "Raw Core ML hash mismatch")
        actual = rows(raw_path)
        require(len(public_rows) == len(actual) == len(expected_rows) == artifact["rows"], "Comparison count mismatch")
        for published, coreml, (split, mlx) in zip(public_rows, actual, expected_rows):
            require(set(published) == FIELDS, "Unexpected/missing public field")
            require(published["split"] == split, "Public split mismatch")
            require(all(published[key] == coreml[key] == mlx[key] for key in ("id", "values", "status")), "Decision identity changed")
            require(coreml["target"] == mlx["target"], "Reference labels changed")
            require(published["mlxProbabilities"] == mlx["probabilities"] and published["coremlProbabilities"] == coreml["probabilities"], "Published probabilities changed")
            for key in ("mlxProbabilities", "coremlProbabilities"):
                probs = published[key]
                require(len(probs) == len(published["values"]) and probs, "Probability shape mismatch")
                require(all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in probs), "Invalid probability")
                require(abs(sum(probs) - 1) <= 1e-5, "Probability mass mismatch")
            expected = aggregate([published])
            require(published["argmaxAgreement"] is (expected["argmaxAgreement"] == 1), "Row argmax flag mismatch")
            require(published["maxProbabilityDelta"] == expected["maxProbabilityDelta"], "Row delta mismatch")
        grouped = {"overall": aggregate(public_rows), **{split: aggregate([row for row in public_rows if row["split"] == split]) for split in SPLITS}}
        evaluation = report["evaluations"][units]
        for split, recomputed in grouped.items():
            recorded = evaluation if split == "overall" else evaluation["splits"][split]
            require(recomputed["supported"] == recorded["decisionsCompared"], "Recorded comparison count mismatch")
            require(recomputed["argmaxAgreement"] == recorded["argmaxAgreement"], "Recorded agreement mismatch")
            require(recomputed["maxProbabilityDelta"] == recorded["maxProbabilityDelta"], "Recorded delta mismatch")
            require(all(recomputed[k] == recorded["metrics"]["overall"]["total" if k == "rows" else k] for k in ("rows", "supported", "coverage")), "Recorded coverage mismatch")
        strings = [value for row in public_rows for value in row["values"] if isinstance(value, str)]
        require(all(re.fullmatch(r"[A-Za-z0-9_?\-]+", value) for value in strings), "Unexpected free-text option value")
        require(artifact["supported"] == grouped["overall"]["supported"], "Artifact coverage mismatch")
        grouped["datasets"] = dict(Counter(row["id"].split("/")[0] for row in public_rows))
        typed_cases = Counter(row["id"].split("/")[1] for row in public_rows if row["id"].startswith("typed_decisions/"))
        require(len(typed_cases) == 400 and set(typed_cases.values()) == {5}, "Typed Decisions case/question coverage mismatch")
        grouped["typedDecisionsCases"] = len(typed_cases)
        grouped["typedDecisionsQuestionsPerCase"] = sorted(set(typed_cases.values()))
        grouped["retainedFields"] = sorted(FIELDS)
        grouped["maximumSemanticOptionIdLength"] = max(map(len, strings))
        comparisons[units] = grouped

    package = LOCATION / "smol-17-float32.mlpackage"
    package_hashes = {str(path.relative_to(package)): sha(path) for path in sorted(package.rglob("*")) if path.is_file()}
    require(package_hashes == report["artifact"]["files"], "Exported package bytes changed")
    package_bytes = sum(path.stat().st_size for path in package.rglob("*") if path.is_file())
    require(package_bytes == report["artifact"]["bytes"], "Package byte count mismatch")
    expected_metadata = {"protocol_sha256": source_hashes["protocolSha256"], "revision": provenance["revision"],
                         "readout_sha256": readout_checks["17"], "complete_graph": "true"}
    require(report["artifactVerification"]["allArtifactFileHashesMatched"] is True and
            report["artifactVerification"]["embeddedModelMetadataMatched"] == expected_metadata,
            "Recorded package metadata differs from frozen source identity")
    backbone = LAB / ".cache/apple-decisions/open-models/SmolLM2-360M-Instruct"
    backbone_hashes = {}
    for filename, expected in models["smol"]["files"].items():
        path = backbone / filename
        backbone_hashes[filename] = sha(path)
        require(backbone_hashes[filename] == expected["sha256"] and path.stat().st_size == expected["bytes"], "Pinned backbone file changed")
    timing_hash = sha(LOCATION / "coreml-timing-input.npz")
    for timing in report["isolatedRuntimeMeasurements"].values():
        require(timing["inputTensorsSha256"] == timing_hash, "Prepared timing tensors changed")
        require(timing["timingInputId"] == expected_rows[0][1]["id"], "Timing input differs from fixed first validation row")
    publication = document(TRAINING / "publication.json")
    published = next(model for model in publication["models"] if model["id"] == "smol")
    require(published["export"] == report, "Publication Smol export is stale")
    require(all(report["decisionComparisonArtifacts"][u]["file"] in published["evidence"] for u in UNITS), "Public evidence link missing")
    require(sha(report_path) == original_report_sha, "Smol report changed during review")
    result = {
        "recordedAt": datetime.now(timezone.utc).isoformat(), "passed": True,
        "scope": "Smol seed17 saved evidence only. Python standard library; no model/library loading, prediction, browser or performance measurement.",
        "exportReportSha256": original_report_sha, "comparisons": comparisons,
        "publicComparisonSha256": public_hashes, "rawCoremlPredictionSha256": raw_coreml_hashes,
        "sourceHashes": source_hashes, "corpusSplitSha256": corpus_checks,
        "featureFileSha256": feature_checks, "readoutSha256": readout_checks,
        "originalMlxPredictionSha256": prediction_checks, "packageFileSha256": package_hashes,
        "packageBytes": package_bytes, "pinnedBackboneFileSha256": backbone_hashes,
        "preparedTimingInputSha256": timing_hash,
        "publicationSmolExportMatches": True, "publicationLinksBothStreams": True,
        "timingBoundary": report["timingBoundary"],
        "isolatedTimingBoundaries": {units: value["timingBoundary"] for units, value in report["isolatedRuntimeMeasurements"].items()},
        "mlxTimingBoundary": published["robustness"]["mlxTiming"]["note"],
        "sourceReviewHashes": {name: sha(TRAINING / name) for name in ("TypedDecisionStudy.tsx", "export_coreml.py", "export_decision_rows.py", "benchmark_coreml.py", "publish.py")},
        "limits": "Confirms saved-row arithmetic, identity/coverage and preserved byte provenance. Does not regenerate outputs, independently establish execution timestamps/hardware placement, verify original source licenses or evaluate quality superiority. Package description bytes are hash-verified, not independently parsed as protobuf.",
    }
    (HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": True, "comparisons": {u: {k: v for k, v in values.items() if k in ('overall', *SPLITS)} for u, values in comparisons.items()}, "packageBytes": package_bytes}, indent=2))


if __name__ == "__main__":
    main()
