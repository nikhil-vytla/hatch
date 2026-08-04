"""Self-checks on the analysis of a retained evidence file.

Three properties the repo requires of any report recomputed from evidence:

1. Recomputation is byte-stable.
2. Report bytes do not depend on the order rows appear in the evidence file.
   This one failed on first write: the source-clustered bootstrap resamples by
   index, so building its cluster list in dict-insertion order made the
   interval depend on row order. Clusters are now sorted by source id.
3. Validation rejects tampered evidence rather than silently aggregating it.

Run: python verify_analysis.py evidence/main-evidence.jsonl
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from analysis import summarize

SHUFFLE_SEEDS = (7, 13, 99, 20260803)


def _canonical(report: dict) -> str:
    return json.dumps(report, sort_keys=True, separators=(",", ":"))


def main() -> None:
    source = Path(sys.argv[1])
    work = Path("/tmp/parallax-verify-analysis")
    work.mkdir(parents=True, exist_ok=True)
    baseline = _canonical(summarize(source))

    if _canonical(summarize(source)) != baseline:
        raise SystemExit("FAIL: recomputation is not byte-stable")
    print("ok: recomputation is byte-stable")

    lines = source.read_text().splitlines()
    for seed in SHUFFLE_SEEDS:
        shuffled = list(lines)
        random.Random(seed).shuffle(shuffled)
        path = work / f"shuffled-{seed}.jsonl"
        path.write_text("\n".join(shuffled) + "\n")
        if _canonical(summarize(path)) != baseline:
            raise SystemExit(f"FAIL: report changed under row shuffle seed {seed}")
    print(f"ok: report is invariant under {len(SHUFFLE_SEEDS)} row shuffles")

    dropped = work / "dropped-row.jsonl"
    dropped.write_text("\n".join(lines[:-1]) + "\n")
    try:
        summarize(dropped)
    except ValueError as error:
        print(f"ok: a missing scheduled row is rejected ({error})")
    else:
        raise SystemExit("FAIL: a missing scheduled row was aggregated")

    duplicated = work / "duplicated-row.jsonl"
    duplicated.write_text("\n".join([*lines, lines[-1]]) + "\n")
    try:
        summarize(duplicated)
    except ValueError as error:
        print(f"ok: a duplicated row is rejected ({error})")
    else:
        raise SystemExit("FAIL: a duplicated row was aggregated")

    tampered = work / "tampered-seed.jsonl"
    rewritten: list[str] = []
    patched = False
    for line in lines:
        row = json.loads(line)
        if not patched and row.get("kind") == "run":
            row["trial_seed"] = row["trial_seed"] + 1
            patched = True
            rewritten.append(json.dumps(row, sort_keys=True, separators=(",", ":")))
            continue
        rewritten.append(line)
    tampered.write_text("\n".join(rewritten) + "\n")
    try:
        summarize(tampered)
    except ValueError as error:
        print(f"ok: seed drift is rejected ({error})")
    else:
        raise SystemExit("FAIL: seed drift was aggregated")

    print("all analysis self-checks passed")


if __name__ == "__main__":
    main()
