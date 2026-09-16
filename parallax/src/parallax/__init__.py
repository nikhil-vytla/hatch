"""Parallax: perturbing tasks and measuring what the perturbation did.

The package is organized around four ideas rather than around
method-times-benchmark:

- `task` — a task is public material plus sealed material plus a verifier.
  `gsm8k` and `swebench` are adapters that fill those slots.
- `perturbation` — a perturbation turns one task into the conditions to compare
  it under, and says whether it derived them from a reference task
  (`intent_evolution`, `intent_phases`) or synthesized them
  (`checkpoint_evolution`).
- `experiment` — one loop: plan, admit, execute, resume, meter, journal.
- `findings` — one analysis: evidence in, contrast and readable summary out.
"""

from .admission import AdmissionError, admit_swe_task, check_admission
from .checkpoint_evolution import (
    CheckpointError,
    admit_family,
    build_checkpoint_variants,
    load_seed_family,
    verify_stage,
)
from .experiment import (
    ExperimentConfig,
    SpendApprovalRequired,
    execute,
    journal_contents,
    plan_experiment,
    total_spend_usd,
    write_plan,
)
from .findings import Findings, classify, render, summarize
from .gsm8k import Gsm8kError, load_gsm8k
from .intent_evolution import ConstructionError, build_intent_variants
from .intent_phases import build_phase_variants, construct_phases
from .outcome import BudgetError
from .perturbation import Condition, Turn, Variant, VariantSet
from .provider import PRICING, ProviderError, pricing_for
from .swebench import SweBenchError, fetch_swebench_verified
from .swebench_specs import compile_bundle, freeze_swe_task
from .task import Task

__all__ = [
    "PRICING",
    "AdmissionError",
    "BudgetError",
    "CheckpointError",
    "Condition",
    "ConstructionError",
    "ExperimentConfig",
    "Findings",
    "Gsm8kError",
    "ProviderError",
    "SpendApprovalRequired",
    "SweBenchError",
    "Task",
    "Turn",
    "Variant",
    "VariantSet",
    "admit_family",
    "admit_swe_task",
    "build_checkpoint_variants",
    "build_intent_variants",
    "build_phase_variants",
    "check_admission",
    "classify",
    "compile_bundle",
    "construct_phases",
    "execute",
    "fetch_swebench_verified",
    "freeze_swe_task",
    "journal_contents",
    "load_gsm8k",
    "load_seed_family",
    "plan_experiment",
    "pricing_for",
    "render",
    "summarize",
    "total_spend_usd",
    "verify_stage",
    "write_plan",
]
