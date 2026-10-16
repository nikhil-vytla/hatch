"""A committed mutation gauntlet.

Several READMEs certified mutation scores for gauntlets that were never
committed, so the repository's most-cited verification artifact could not be
reproduced. This module is the reproducible version: each mutation breaks one
contract-bearing line, and the test asserts that the suite notices.

Run just this gate with `pytest -m mutation`, or skip it with
`pytest -m 'not mutation'`.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest

SOURCE = Path(__file__).parents[1]
# `research/` comes along: several tests replay committed evidence, and a
# sandbox without it would fail them for a missing file, which reads as a kill
# no matter what the mutation did.
IGNORED = shutil.ignore_patterns(
    ".git",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "dist",
    "live-work",
)


@dataclass(frozen=True)
class Mutation:
    name: str
    path: str
    old: str
    new: str
    tests: tuple[str, ...]


MUTATIONS = (
    Mutation(
        "delivery_accepts_a_missing_turn",
        "src/parallax/delivery.py",
        "if len(self.phases) != self.turn_count:",
        "if False:",
        ("tests/test_delivery.py",),
    ),
    Mutation(
        "delivery_grades_before_every_turn_is_delivered",
        "src/parallax/delivery.py",
        "if self._receipt is None:",
        "if False:",
        ("tests/test_delivery.py",),
    ),
    Mutation(
        "environment_skips_the_delivery_count_gate",
        "src/parallax/swebench_runtime.py",
        "if receipt.turn_count != len(turns):",
        "if False:",
        ("tests/test_swebench_env.py",),
    ),
    Mutation(
        "noop_gate_accepts_an_unapplied_identity_patch",
        "src/parallax/admission.py",
        "and evaluation.patch_successfully_applied",
        "and True",
        ("tests/test_admission.py",),
    ),
    Mutation(
        "admission_ignores_a_failed_gate",
        "src/parallax/admission.py",
        "passed = noop.passed and gold.passed",
        "passed = True",
        ("tests/test_admission.py",),
    ),
    Mutation(
        "scheduling_skips_the_admission_identity_proof",
        "src/parallax/screening.py",
        "        assert_admission_identity(item)",
        "        pass",
        ("tests/test_admission.py",),
    ),
    Mutation(
        "unknown_model_is_priced_at_zero_instead_of_raising",
        "src/parallax/metering.py",
        '        known = ", ".join(sorted(MODEL_PRICING))',
        "        return TokenPricing(\n"
        "            input_usd_per_million=1e-9,\n"
        "            output_usd_per_million=1e-9,\n"
        "        )\n"
        '        known = ", ".join(sorted(MODEL_PRICING))',
        ("tests/test_metering.py",),
    ),
    Mutation(
        "cost_is_metered_at_a_single_shared_rate",
        "src/parallax/metering.py",
        "    pricing = pricing_for(model)",
        '    pricing = pricing_for("claude-opus-4-8")',
        ("tests/test_metering.py",),
    ),
    Mutation(
        "wire_parsing_rejects_the_json_arrays_tuples_arrive_as",
        "src/parallax/hud_wire.py",
        "        return model.model_validate_json(document)",
        "        return model.model_validate(json.loads(document))",
        ("tests/test_hud_wire.py",),
    ),
    Mutation(
        "wire_tuple_handles_null_but_breaks_ordinary_arrays",
        "src/parallax/hud_wire.py",
        "    if isinstance(value, list):\n        return tuple(value)",
        "    if False:\n        return tuple(value)",
        ("tests/test_hud_wire.py", "tests/test_provider.py"),
    ),
    Mutation(
        "json_code_fences_are_not_stripped",
        "src/parallax/hud_wire.py",
        '    return match.group("body") if match else text',
        "    return text",
        ("tests/test_hud_wire.py",),
    ),
    Mutation(
        "a_cached_episode_keeps_the_price_it_was_written_with",
        "src/parallax/hud_screening.py",
        "    @property\n"
        "    def usage(self) -> MeteredUsage:\n"
        "        return meter(\n"
        "            self.reported_model,\n"
        "            prompt_tokens=self.prompt_tokens,\n"
        "            completion_tokens=self.completion_tokens,\n"
        "        )",
        "    cost_usd: float = 0.0\n"
        "\n"
        "    @property\n"
        "    def usage(self) -> MeteredUsage:\n"
        "        return MeteredUsage(\n"
        "            prompt_tokens=self.prompt_tokens,\n"
        "            completion_tokens=self.completion_tokens,\n"
        "            cost_usd=self.cost_usd,\n"
        "        )",
        ("tests/test_hud_screening.py",),
    ),
    Mutation(
        "dataset_test_lists_must_arrive_as_json_text",
        "src/parallax/swebench.py",
        "        return wire_tuple(value)",
        "        return value",
        ("tests/test_swebench.py",),
    ),
    Mutation(
        "episode_cache_keys_drop_the_arm",
        "src/parallax/hud_screening.py",
        'f"{unit.arm}-trial-{unit.trial_index}"',
        'f"trial-{unit.trial_index}"',
        ("tests/test_hud_screening.py",),
    ),
    Mutation(
        "a_second_writer_to_one_evidence_file_is_admitted",
        "src/parallax/screening.py",
        "            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        "            pass",
        ("tests/test_screening.py",),
    ),
    Mutation(
        "docker_preflight_accepts_the_wrong_platform",
        "src/parallax/preflight.py",
        'if os.environ["DOCKER_DEFAULT_PLATFORM"] != DOCKER_PLATFORM:',
        "if False:",
        ("tests/test_preflight.py",),
    ),
    Mutation(
        "terminate_group_signals_only_the_wrapper",
        "src/parallax/preflight.py",
        "            os.killpg(group, sig)",
        "            os.kill(process.pid, sig)",
        ("tests/test_preflight.py",),
    ),
    Mutation(
        "operating_point_margins_collapse_to_exact_equality",
        "src/parallax/screening.py",
        "    if pass_rate <= FLOOR_PASS_RATE:",
        "    if pass_rate == 0:",
        ("tests/test_screening.py",),
    ),
    Mutation(
        "checkpoint_replies_are_parsed_without_unwrapping_the_fence",
        "src/parallax/checkpoint_agent.py",
        "    payload = strip_json_fence(text)",
        "    payload = text",
        ("tests/test_checkpoint_agent.py",),
    ),
    Mutation(
        "checkpoint_stage_pricing_drifts_from_the_canonical_table",
        "src/parallax/checkpoint_agent.py",
        'STAGE_MODEL = "claude-haiku-4-5"',
        'STAGE_MODEL = "claude-opus-4-8"',
        ("tests/test_checkpoint_agent.py", "tests/test_checkpoint_screening.py"),
    ),
    Mutation(
        "paired_bounds_treat_a_missing_side_as_a_point",
        "src/parallax/paired.py",
        "        return float(-baseline), float(1 - baseline)",
        "        return float(-baseline), float(-baseline)",
        ("tests/test_paired.py",),
    ),
    Mutation(
        "spend_audit_trusts_the_recorded_dollar_figures",
        "research/spend-audit-20260803/audit_spend.py",
        "        payments[_unit_key(record)] = meter(\n"
        "            record.reported_model,\n"
        "            prompt_tokens=record.prompt_tokens,\n"
        "            completion_tokens=record.completion_tokens,\n"
        "        )",
        "        payments[_unit_key(record)] = MeteredUsage(\n"
        "            prompt_tokens=record.prompt_tokens,\n"
        "            completion_tokens=record.completion_tokens,\n"
        "            cost_usd=record.estimated_cost_usd,\n"
        "        )",
        ("tests/test_spend_ledger.py",),
    ),
    Mutation(
        "spend_audit_counts_replayed_episodes_again",
        "research/spend-audit-20260803/audit_spend.py",
        "    if key in spec.superseded_units:",
        "    if True:",
        ("tests/test_spend_ledger.py",),
    ),
)


def _run_tests(root: Path, tests: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:randomly", *tests],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=300,
        check=False,
    )


@pytest.fixture(scope="module")
def pristine_tree():
    with tempfile.TemporaryDirectory(prefix="parallax-gauntlet-") as tmp:
        root = Path(tmp) / "parallax"
        shutil.copytree(SOURCE, root, ignore=IGNORED)
        yield root


@pytest.mark.mutation
def test_mutation_names_are_unique() -> None:
    names = [mutation.name for mutation in MUTATIONS]

    assert len(set(names)) == len(names)


@pytest.mark.mutation
@pytest.mark.parametrize("mutation", MUTATIONS, ids=lambda item: item.name)
def test_mutation_is_killed(mutation: Mutation, pristine_tree: Path, tmp_path) -> None:
    root = tmp_path / "parallax"
    shutil.copytree(pristine_tree, root)
    target = root / mutation.path
    source = target.read_text(encoding="utf-8")

    assert source.count(mutation.old) == 1, (
        f"{mutation.name} no longer matches exactly one site in {mutation.path}; "
        "the gauntlet is stale, not the code"
    )
    target.write_text(
        source.replace(mutation.old, mutation.new),
        encoding="utf-8",
    )

    result = _run_tests(root, mutation.tests)

    assert result.returncode != 0, (
        f"{mutation.name} survived: {' '.join(mutation.tests)} passed against "
        f"mutated {mutation.path}\n{result.stdout[-3000:]}"
    )
