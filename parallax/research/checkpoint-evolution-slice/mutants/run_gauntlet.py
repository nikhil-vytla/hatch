"""Behavioral mutation gauntlet for the checkpoint-evolution slice.

Applies targeted semantic mutants to the two new modules and requires the
offline suite to fail (kill) for every mutant. Restores the tree afterward.

Run from the repo root:

    uv run --project parallax \\
        python parallax/research/checkpoint-evolution-slice/mutants/run_gauntlet.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PARALLAX = Path(__file__).resolve().parents[3]
EVOLUTION = PARALLAX / "src" / "parallax" / "checkpoint_evolution.py"
RUNNER = PARALLAX / "src" / "parallax" / "checkpoint_runner.py"
AGENT = PARALLAX / "src" / "parallax" / "checkpoint_agent.py"
SANDBOX = PARALLAX / "src" / "parallax" / "checkpoint_sandbox.py"
SCREENING = PARALLAX / "src" / "parallax" / "checkpoint_screening.py"
TESTS = (
    "tests/test_checkpoint_evolution.py",
    "tests/test_checkpoint_runner.py",
    "tests/test_checkpoint_agent.py",
    "tests/test_checkpoint_sandbox.py",
    "tests/test_checkpoint_screening.py",
)

MUTANTS: tuple[tuple[str, Path, str, str], ...] = (
    (
        "M01 regression obligations dropped from the accumulated suite",
        EVOLUTION,
        "            if checkpoint.index <= index\n",
        "            if checkpoint.index == index\n",
    ),
    (
        "M02 strict verdict ignores regression results",
        EVOLUTION,
        "        strict_pass=all(result.passed for result in results),\n",
        "        strict_pass=all(result.passed for result in new),\n",
    ),
    (
        "M03 every graded case labeled new",
        EVOLUTION,
        '            role="new" if origin == index else "regression",\n',
        '            role="new",\n',
    ),
    (
        "M04 no-op gate inverted",
        EVOLUTION,
        "        if verify_stage(family, checkpoint.index, prior).isolated_pass:\n",
        "        if not verify_stage(family, checkpoint.index, prior).isolated_pass:\n",
    ),
    (
        "M05 gold gate accepts isolated instead of strict",
        EVOLUTION,
        "        if not verification.strict_pass:\n            failed = tuple(\n",
        "        if not verification.isolated_pass:\n            failed = tuple(\n",
    ),
    (
        "M06 leakage gate never finds anything",
        EVOLUTION,
        "        if case.case_id in checkpoint.public_spec\n"
        "        or canonical_bytes(case).decode() in checkpoint.public_spec\n",
        "        if False\n",
    ),
    (
        "M07 exit codes not compared",
        EVOLUTION,
        "    if completed.returncode != case.expected_exit_code:\n"
        '        return "exit-code-mismatch"\n',
        "",
    ),
    (
        "M08 case timeout reclassified as infrastructure",
        EVOLUTION,
        '        except subprocess.TimeoutExpired:\n            return "timeout"\n',
        "        except subprocess.TimeoutExpired as error:\n"
        '            raise VerifierError("timeout") from error\n',
    ),
    (
        "M09 first checkpoint skipped by the delivery loop",
        RUNNER,
        "    for checkpoint in family.checkpoints:\n",
        "    for checkpoint in family.checkpoints[1:]:\n",
    ),
    (
        "M10 agent workspace not carried forward",
        RUNNER,
        "            carried = produced\n",
        "            carried = opening\n",
    ),
    (
        "M11 missing workspace does not censor the evolved arm",
        RUNNER,
        '        if arm == "evolved":\n'
        "            if produced is None:\n"
        "                break\n"
        "            carried = produced\n",
        '        if arm == "evolved":\n'
        "            if produced is not None:\n"
        "                carried = produced\n",
    ),
    (
        "M12 carry-reference arm collapses into evolved",
        RUNNER,
        "            opening = (\n"
        "                EMPTY_WORKSPACE\n"
        "                if checkpoint.index == 1\n"
        "                else admitted.references.stages[checkpoint.index - 2]\n"
        "            )\n",
        "            opening = carried\n",
    ),
    (
        "M13 manifest design digest unbound from its body",
        RUNNER,
        "        design_digest=DesignDigest(canonical_digest(body)),\n",
        "        design_digest=DesignDigest(canonical_digest({})),\n",
    ),
    (
        "M14 delivered-spec drift check disabled",
        RUNNER,
        "            if receipt.spec_digest != checkpoint.spec_digest:\n",
        "            if False:\n",
    ),
    (
        "M15 live screening bypasses the sandbox for model-written code",
        SCREENING,
        "        execute = (\n"
        "            SandboxCaseExecution(PINNED_SANDBOX)\n"
        "            if sandbox_runner is None\n"
        "            else SandboxCaseExecution(PINNED_SANDBOX, runner=sandbox_runner)\n"
        "        )\n"
        '        execution_identity = f"sandbox:{PINNED_SANDBOX.image}"\n'
        "        if not math.isfinite(spend_cap_usd)",
        "        execute = run_case_trusted\n"
        '        execution_identity = f"sandbox:{PINNED_SANDBOX.image}"\n'
        "        if not math.isfinite(spend_cap_usd)",
    ),
    (
        "M16 sandbox network isolation dropped",
        SANDBOX,
        '            "--network=none",\n',
        "",
    ),
    (
        "M17 sandbox root filesystem made writable",
        SANDBOX,
        '            "--read-only",\n',
        "",
    ),
    (
        "M18 in-container deadline no longer a case timeout",
        SANDBOX,
        "        if completed.returncode == CASE_TIMEOUT_EXIT_CODE:\n"
        '            return "timeout"\n',
        "",
    ),
    (
        "M19 docker faults regraded as case verdicts",
        SANDBOX,
        "        if completed.returncode in DOCKER_FAULT_EXIT_CODES and (\n"
        '            "docker:" in completed.stderr or "OCI runtime" in '
        "completed.stderr\n"
        "        ):\n",
        "        if False:\n",
    ),
    (
        "M20 truncated reply no longer a budget fault",
        AGENT,
        '                BudgetError("stage reply reached its output-token limit"),\n',
        "                AgentReplyError"
        '("stage reply reached its output-token limit"),\n',
    ),
    (
        "M21 stage usage dropped before the receipt",
        RUNNER,
        "    return workspace, usage\n",
        "    return workspace, None\n",
    ),
    (
        "M22 reported-model drift accepted",
        AGENT,
        "        if response.model != self._expected_response_model:\n",
        "        if False:\n",
    ),
    (
        "M23 fence unwrap disabled",
        AGENT,
        "    payload = strip_json_fence(text)\n",
        "    payload = text\n",
    ),
    (
        "M24 live spend approval gate removed",
        SCREENING,
        "        if not approve_spend:\n",
        "        if False:\n",
    ),
)


def run_suite() -> int:
    return subprocess.run(
        (sys.executable, "-m", "pytest", *TESTS, "-q", "-x", "-p", "no:cacheprovider"),
        cwd=PARALLAX,
        capture_output=True,
        text=True,
    ).returncode


def main() -> int:
    baseline = run_suite()
    if baseline != 0:
        print("baseline suite is failing; gauntlet aborted")
        return 2
    survivors: list[str] = []
    for name, path, old, new in MUTANTS:
        original = path.read_text(encoding="utf-8")
        if original.count(old) != 1:
            print(f"{name}: NOT APPLICABLE (target occurs {original.count(old)}x)")
            survivors.append(name)
            continue
        path.write_text(original.replace(old, new), encoding="utf-8")
        try:
            outcome = run_suite()
        finally:
            path.write_text(original, encoding="utf-8")
        status = "killed" if outcome != 0 else "SURVIVED"
        print(f"{name}: {status}")
        if outcome == 0:
            survivors.append(name)
    confirm = run_suite()
    if confirm != 0:
        print("tree did not restore cleanly")
        return 2
    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} mutants killed")
    return 1 if survivors else 0


if __name__ == "__main__":
    raise SystemExit(main())
