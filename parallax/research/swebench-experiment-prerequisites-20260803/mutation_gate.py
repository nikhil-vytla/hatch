from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

SOURCE = Path(__file__).parents[2]
PYTHON = SOURCE / ".venv" / "bin" / "python"


@dataclass(frozen=True)
class Mutation:
    name: str
    path: str
    old: str
    new: str


MUTATIONS = (
    Mutation(
        "delivery_accepts_missing_turn",
        "src/parallax/delivery.py",
        "if len(self.phases) != self.turn_count:",
        "if False:",
    ),
    Mutation(
        "delivery_returns_incomplete_receipt",
        "src/parallax/delivery.py",
        "if self._receipt is None:",
        "if False:",
    ),
    Mutation(
        "environment_skips_delivery_count_gate",
        "src/parallax/swebench_runtime.py",
        "if receipt.turn_count != len(turns):",
        "if False:",
    ),
    Mutation(
        "noop_accepts_unapplied_identity_patch",
        "src/parallax/admission.py",
        "and evaluation.patch_successfully_applied",
        "and True",
    ),
    Mutation(
        "admission_ignores_failed_gate",
        "src/parallax/admission.py",
        "passed = all(gate.passed for gate in (*cheap, noop, gold))",
        "passed = True",
    ),
    Mutation(
        "conformance_ignores_delivery_skip",
        "src/parallax/conformance.py",
        "if actual != expected:",
        "if False:",
    ),
)


def _mutate(root: Path, mutation: Mutation) -> None:
    path = root / mutation.path
    source = path.read_text(encoding="utf-8")
    if source.count(mutation.old) != 1:
        raise RuntimeError(f"{mutation.name} does not match exactly once")
    path.write_text(source.replace(mutation.old, mutation.new), encoding="utf-8")


def _test(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(PYTHON),
            "-m",
            "pytest",
            "-q",
            "tests/test_delivery.py",
            "tests/test_swebench_env.py",
            "tests/test_admission.py",
            "tests/test_conformance.py",
        ],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def main() -> None:
    baseline = _test(SOURCE)
    if baseline.returncode:
        raise SystemExit(f"baseline failed\n{baseline.stdout}\n{baseline.stderr}")
    survivors = []
    for mutation in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix="parallax-prerequisite-mutant-") as tmp:
            root = Path(tmp) / "parallax"
            shutil.copytree(
                SOURCE,
                root,
                ignore=shutil.ignore_patterns(
                    ".git",
                    ".venv",
                    ".pytest_cache",
                    ".ruff_cache",
                    "dist",
                    "__pycache__",
                    "live-work",
                ),
            )
            _mutate(root, mutation)
            result = _test(root)
            killed = result.returncode != 0
            print(f"{'KILLED' if killed else 'SURVIVED'} {mutation.name}")
            if not killed:
                survivors.append(mutation.name)
    print(f"active={len(MUTATIONS)} survivors={len(survivors)}")
    if survivors:
        raise SystemExit(f"surviving mutations: {survivors}")


if __name__ == "__main__":
    main()
