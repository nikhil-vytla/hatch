from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from pyarrow.parquet import read_table

from parallax.admission import (
    admit_swe_family,
    read_admission_record,
    write_admission_record,
)
from parallax.canonical import atomic_write, canonical_bytes
from parallax.swebench import (
    ImageDigest,
    SweConstruction,
    VerifierRuntime,
    build_swe_script_family,
    load_swebench_rows,
)

ROOT = Path(__file__).parent
ROUND_TWO = ROOT.parent / "swebench-screening-round2-20260803"
PARQUET = Path("/tmp/swebench-verified-91aa3ed.parquet")
PARQUET_DIGEST = "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21"
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
CONSTRUCTION_FILES = (
    ROUND_TWO / "evidence" / "construction.jsonl",
    ROUND_TWO / "evidence" / "remaining-medium-construction.jsonl",
)
EVIDENCE = ROOT / "evidence"
LIVE_WORK = EVIDENCE / "live-work"
HARNESS_SOURCE = (
    ROUND_TWO / "evidence" / "remaining-medium-live-work" / "swebench-harness-source"
)


def _constructions() -> dict[str, SweConstruction]:
    selected = {f"swebench:{instance_id}" for instance_id in INSTANCE_DIGESTS}
    constructions = {}
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


def main() -> None:
    os.environ.setdefault("DOCKER_DEFAULT_PLATFORM", "linux/amd64")
    if hashlib.sha256(PARQUET.read_bytes()).hexdigest() != PARQUET_DIGEST:
        raise ValueError("pinned Verified parquet digest mismatch")
    rows = {
        row["instance_id"]: row
        for row in read_table(PARQUET).to_pylist()
        if row["instance_id"] in INSTANCE_DIGESTS
    }
    instance_ids = tuple(INSTANCE_DIGESTS)
    problems = load_swebench_rows(
        tuple(rows[instance_id] for instance_id in instance_ids),
        instance_ids,
        runtimes={
            instance_id: VerifierRuntime(image_digest=ImageDigest(digest))
            for instance_id, digest in INSTANCE_DIGESTS.items()
        },
    )
    constructions = _constructions()
    records = []
    for problem in problems:
        output = EVIDENCE / str(problem.instance_id) / "admission.json"
        if output.exists():
            records.append(read_admission_record(output))
            continue
        family = build_swe_script_family(
            problem,
            constructions[str(problem.record_id)],
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        record = admit_swe_family(
            family,
            work_directory=LIVE_WORK / str(problem.instance_id),
            harness_source_directory=HARNESS_SOURCE,
        )
        write_admission_record(record, output)
        records.append(record)
    summary = {
        "dataset_parquet_digest": PARQUET_DIGEST,
        "decisions": {str(record.source_id): record.decision for record in records},
        "docker_platform": os.environ["DOCKER_DEFAULT_PLATFORM"],
        "gate_order": [gate.gate for gate in records[0].gates],
        "sources": instance_ids,
    }
    atomic_write(EVIDENCE / "admission-summary.json", canonical_bytes(summary) + b"\n")


if __name__ == "__main__":
    main()
