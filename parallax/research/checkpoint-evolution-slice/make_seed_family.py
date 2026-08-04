"""Generate the hand-verified checkpoint-evolution seed family fixture.

Writes parallax/tests/fixtures/checkpoint_family.json deterministically.
Run from anywhere: python3 make_seed_family.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PARALLAX = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PARALLAX / "src"))

from parallax.checkpoint_evolution import (  # noqa: E402
    CheckpointFamily,
    CheckpointSpec,
    EntrypointContract,
    ReferenceBuild,
    SealedCase,
    SeedFamilyFixture,
    Workspace,
    WorkspaceFile,
    admit_family,
)
from parallax.types import SourceId  # noqa: E402

SPEC_1 = """\
# tally, checkpoint 1: totals

Build a command-line tool whose entrypoint is `tally.py`, invoked as:

    python3 tally.py total

Input arrives on standard input as event records, one per line. A record
is `<name> <count>` separated by exactly one space, where `<name>` is one
or more lowercase ASCII letters and `<count>` is a non-negative decimal
integer. Blank lines are ignored. Input with no records is valid.

`total` prints the sum of all counts as a decimal integer followed by a
single newline, then exits 0.

Example: input `gamma 7` then `delta 4` prints `11` and exits 0. Empty
input prints `0` and exits 0.

Errors: for any malformed record, or for an unknown or missing
subcommand, write a message to standard error, print nothing to standard
output, and exit 2. The wording of error messages is not constrained.

Normalization: output ends with exactly one trailing newline; no other
whitespace is emitted on standard output.
"""

SPEC_2 = """\
# tally, checkpoint 2: top name

Extend `tally.py` with a second subcommand:

    python3 tally.py top

`top` aggregates counts per name and prints the name with the largest
aggregated total, followed by a single newline, then exits 0. If two or
more names tie for the largest total, print the lexicographically
smallest of the tied names (bytewise comparison of the ASCII names).

Example: input `gamma 2`, `delta 9`, `gamma 8` prints `gamma` (gamma
totals 10, delta 9). Example: input `epsilon 5`, `delta 5` prints
`delta` (tie broken lexicographically).

If the input contains no records, `top` writes a message to standard
error, prints nothing to standard output, and exits 1.

All checkpoint 1 behavior is unchanged, including `total` output and the
exit-2 error contract for malformed records and unknown subcommands.
"""

SPEC_3 = """\
# tally, checkpoint 3: file input

Extend `tally.py` to read records from a file as an alternative to
standard input:

    python3 tally.py --input FILE total
    python3 tally.py --input FILE top

When `--input FILE` is present (it always precedes the subcommand), read
records from FILE, resolved relative to the working directory, and
ignore standard input entirely. When it is absent, behavior is exactly
as before: records come from standard input for both subcommands.

Example: with a file `events.txt` containing `gamma 1` and `gamma 2`,
`python3 tally.py --input events.txt total` prints `3` and exits 0.

If FILE cannot be opened, write a message to standard error, print
nothing to standard output, and exit 3. Malformed records inside FILE
keep the existing exit-2 error contract. `--input` without a following
path is a usage error: exit 2, message to standard error.
"""

READ_RECORDS = """\
def read_records(stream):
    records = []
    for line in stream:
        text = line.strip("\\n")
        if not text:
            continue
        parts = text.split(" ")
        if (
            len(parts) != 2
            or not parts[0].isalpha()
            or not parts[0].islower()
            or not parts[0].isascii()
            or not (parts[1].isdigit() and parts[1].isascii())
        ):
            raise ValueError("malformed record: " + text)
        records.append((parts[0], int(parts[1])))
    return records
"""

REFERENCE_1 = f"""\
import sys


{READ_RECORDS}

def main(argv):
    if len(argv) != 1 or argv[0] != "total":
        print("usage: tally.py total", file=sys.stderr)
        return 2
    try:
        records = read_records(sys.stdin)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    print(sum(count for _, count in records))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
"""

REFERENCE_2 = f"""\
import sys


{READ_RECORDS}

def totals_by_name(records):
    totals = {{}}
    for name, count in records:
        totals[name] = totals.get(name, 0) + count
    return totals


def main(argv):
    if len(argv) != 1 or argv[0] not in ("total", "top"):
        print("usage: tally.py total|top", file=sys.stderr)
        return 2
    try:
        records = read_records(sys.stdin)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if argv[0] == "total":
        print(sum(count for _, count in records))
        return 0
    totals = totals_by_name(records)
    if not totals:
        print("no records for top", file=sys.stderr)
        return 1
    print(min(totals, key=lambda name: (-totals[name], name)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
"""

REFERENCE_3 = f"""\
import sys


{READ_RECORDS}

def totals_by_name(records):
    totals = {{}}
    for name, count in records:
        totals[name] = totals.get(name, 0) + count
    return totals


def run(command, records):
    if command == "total":
        print(sum(count for _, count in records))
        return 0
    totals = totals_by_name(records)
    if not totals:
        print("no records for top", file=sys.stderr)
        return 1
    print(min(totals, key=lambda name: (-totals[name], name)))
    return 0


def main(argv):
    path = None
    if argv[:1] == ["--input"]:
        if len(argv) < 2:
            print("usage: tally.py [--input FILE] total|top", file=sys.stderr)
            return 2
        path = argv[1]
        argv = argv[2:]
    if len(argv) != 1 or argv[0] not in ("total", "top"):
        print("usage: tally.py [--input FILE] total|top", file=sys.stderr)
        return 2
    if path is None:
        stream = sys.stdin
    else:
        try:
            stream = open(path, encoding="utf-8")
        except OSError as error:
            print(error, file=sys.stderr)
            return 3
    try:
        records = read_records(stream)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    finally:
        if path is not None:
            stream.close()
    return run(argv[0], records)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
"""


def case(
    case_id: str,
    category: str,
    argv: tuple[str, ...],
    stdin_text: str,
    expected_stdout: str,
    expected_exit_code: int,
    *,
    expect_stderr: bool = False,
    input_files: tuple[tuple[str, str], ...] = (),
) -> SealedCase:
    return SealedCase(
        case_id=case_id,
        category=category,
        argv=argv,
        stdin_text=stdin_text,
        input_files=tuple(
            WorkspaceFile(path=path, content=content) for path, content in input_files
        ),
        expected_stdout=expected_stdout,
        expected_exit_code=expected_exit_code,
        expect_stderr=expect_stderr,
    )


def build_fixture() -> SeedFamilyFixture:
    family = CheckpointFamily(
        family_id=SourceId("ce-tally-1"),
        contract=EntrypointContract(
            interpreter="python3",
            entry_file="tally.py",
            timeout_seconds=15.0,
        ),
        checkpoints=(
            CheckpointSpec(
                index=1,
                operator="core",
                public_spec=SPEC_1,
                max_output_bytes=4096,
                cases=(
                    case(
                        "t1-total-basic",
                        "core",
                        ("total",),
                        "alpha 2\nbeta 3\nalpha 5\n",
                        "10\n",
                        0,
                    ),
                    case(
                        "t1-total-empty",
                        "functionality",
                        ("total",),
                        "",
                        "0\n",
                        0,
                    ),
                    case(
                        "t1-total-malformed",
                        "error",
                        ("total",),
                        "alpha two\n",
                        "",
                        2,
                        expect_stderr=True,
                    ),
                ),
            ),
            CheckpointSpec(
                index=2,
                operator="extension",
                public_spec=SPEC_2,
                max_output_bytes=4096,
                cases=(
                    case(
                        "t2-top-basic",
                        "core",
                        ("top",),
                        "alpha 2\nbeta 3\nalpha 5\n",
                        "alpha\n",
                        0,
                    ),
                    case(
                        "t2-top-tie",
                        "functionality",
                        ("top",),
                        "beta 4\nalpha 4\n",
                        "alpha\n",
                        0,
                    ),
                    case(
                        "t2-top-empty",
                        "error",
                        ("top",),
                        "",
                        "",
                        1,
                        expect_stderr=True,
                    ),
                ),
            ),
            CheckpointSpec(
                index=3,
                operator="input-source",
                public_spec=SPEC_3,
                max_output_bytes=4096,
                cases=(
                    case(
                        "t3-file-total",
                        "core",
                        ("--input", "data.txt", "total"),
                        "",
                        "3\n",
                        0,
                        input_files=(("data.txt", "alpha 2\nbeta 1\n"),),
                    ),
                    case(
                        "t3-file-top",
                        "functionality",
                        ("--input", "data.txt", "top"),
                        "",
                        "alpha\n",
                        0,
                        input_files=(("data.txt", "beta 3\nalpha 3\n"),),
                    ),
                    case(
                        "t3-stdin-preserved",
                        "functionality",
                        ("total",),
                        "alpha 1\n",
                        "1\n",
                        0,
                    ),
                    case(
                        "t3-missing-file",
                        "error",
                        ("--input", "absent.txt", "total"),
                        "",
                        "",
                        3,
                        expect_stderr=True,
                    ),
                ),
            ),
        ),
    )
    references = ReferenceBuild(
        family_digest=family.digest,
        stages=(
            Workspace.from_files({"tally.py": REFERENCE_1}),
            Workspace.from_files({"tally.py": REFERENCE_2}),
            Workspace.from_files({"tally.py": REFERENCE_3}),
        ),
    )
    return SeedFamilyFixture(family=family, references=references)


def main() -> int:
    fixture = build_fixture()
    receipt = admit_family(fixture.family, fixture.references)
    if receipt.decision != "admitted":
        for gate in receipt.gates:
            print(f"{gate.gate}: passed={gate.passed} {gate.detail}")
        return 1
    target = PARALLAX / "tests" / "fixtures" / "checkpoint_family.json"
    data = json.dumps(
        fixture.model_dump(mode="json"),
        indent=2,
        sort_keys=True,
        ensure_ascii=False,
    )
    target.write_text(data + "\n", encoding="utf-8")
    print(f"wrote {target} (family digest {fixture.family.digest})")
    for gate in receipt.gates:
        print(f"{gate.gate}: passed={gate.passed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
