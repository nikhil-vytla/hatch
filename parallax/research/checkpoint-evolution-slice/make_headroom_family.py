"""Generate the budget-headroom variant of the seed family.

Identical to `ce-tally-1` (same specs, sealed cases, contract, and
references) except for the per-stage workspace byte caps, which change
from the flat 4096/4096/4096 to the escalating 4096/8192/12288 so that
every cap increment covers at least twice the reference increment
(`budget_headroom_violations` is empty). This is the disambiguation
family for the stage-3 budget confound observed in the first screening
run: it removes byte pressure without touching the reply format.

Run from the repo root:

    uv run --project parallax \\
        python parallax/research/checkpoint-evolution-slice/make_headroom_family.py
"""

from __future__ import annotations

import json
from pathlib import Path

from parallax.checkpoint_evolution import (
    CheckpointFamily,
    ReferenceBuild,
    SeedFamilyFixture,
    admit_family,
    budget_headroom_violations,
    load_seed_family,
)
from parallax.types import SourceId

PARALLAX = Path(__file__).resolve().parents[2]
SEED_PATH = PARALLAX / "tests" / "fixtures" / "checkpoint_family.json"
TARGET = (
    Path(__file__).resolve().parent / "fixtures" / "checkpoint_family_headroom.json"
)

VARIANT_FAMILY_ID = SourceId("ce-tally-1-headroom")
VARIANT_CAPS = (4096, 8192, 12288)


def build_fixture() -> SeedFamilyFixture:
    seed = load_seed_family(SEED_PATH)
    family = CheckpointFamily(
        family_id=VARIANT_FAMILY_ID,
        contract=seed.family.contract,
        checkpoints=tuple(
            checkpoint.model_copy(update={"max_output_bytes": cap})
            for checkpoint, cap in zip(
                seed.family.checkpoints, VARIANT_CAPS, strict=True
            )
        ),
    )
    references = ReferenceBuild(
        family_digest=family.digest,
        stages=seed.references.stages,
    )
    return SeedFamilyFixture(family=family, references=references)


def main() -> int:
    fixture = build_fixture()
    violations = budget_headroom_violations(fixture.family, fixture.references)
    if violations:
        for violation in violations:
            print(violation)
        return 1
    receipt = admit_family(fixture.family, fixture.references)
    if receipt.decision != "admitted":
        for gate in receipt.gates:
            print(f"{gate.gate}: passed={gate.passed} {gate.detail}")
        return 1
    TARGET.parent.mkdir(exist_ok=True)
    data = json.dumps(
        fixture.model_dump(mode="json"),
        indent=2,
        sort_keys=True,
        ensure_ascii=False,
    )
    TARGET.write_text(data + "\n", encoding="utf-8")
    print(f"wrote {TARGET} (family digest {fixture.family.digest})")
    for gate in receipt.gates:
        print(f"{gate.gate}: passed={gate.passed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
