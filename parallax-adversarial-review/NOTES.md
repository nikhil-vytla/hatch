# Parallax Adversarial Architecture Review — Notes

## Intent (from user)
Parallax must become a reproducible autoresearch loop:
1. Versioned source tasks
2. Controlled static + evolving-intent variants
3. Same real model under frozen harness/budgets
4. Executable verifiers
5. One-intervention sweeps
6. Machine-readable provenance/results
7. Findings → next perturbation

First valid prototype: reproduce qualitative Evolving Intent effect on a small baseline; separate harness failures from model failures.

## Scope reviewed
- `hard-repo-tasks/src/parallax/variants.py` (482 LOC; largest module)
- `scripts/plan_variants.py`, `tests/test_variants.py`
- `hud_env/{env.py,tasks.py,tasks.json,.hud_eval.toml,pyproject.toml}`
- `knowledge/syntheses/controlled-task-variation.md`
- `README.md`, `pyproject.toml`
- Supporting: `calibration.py`, `grading.py`, `models.py`, `compiler.py`, `adapters.py`, `admit.py`, `results/live-calibration.json`

## Method
Read adversarial rubric (Correctness, Root Causes, Structural Integrity, Verification, Complexity, Security) and code-quality lens (structural simplification, spaghetti, boundary cleanliness). Traced whether variant types connect to compile → export → HUD execute → grade → calibrate → next intervention. Ran `pytest tests/test_variants.py` (7 passed). Did not modify `hard-repo-tasks`.

## Evidence highlights
- `TaskSpec`/`TaskVariant` used only in variants.py, plan_variants.py, test_variants.py — zero bridge to Recipe/compiler/HUD.
- `plan_variants.py` emits blueprint contracts only; no trajectories, no candidate TaskVariants, no admission artifacts.
- `hud_env/env.py` `repair` is single-yield prompt then grade; no IntentEvent injection; `agent_config.max_steps` hardcoded 80 in adapters; Budget fields unused.
- `StateMode` / `VerifierPolicy` are labels; no runtime enforcement or verifier transform code.
- `decide_curriculum` uses mean rates, exact `strong_rate == 0`, thresholds on tiny N; `failure_tags` unused; no harness fingerprint.
- Live calibration JSON manually separates platform_failures; no typed classifier in code.
- README Limitations already admits generator/execution/grading of variants missing — modeling layer only.
- Knowledge synthesis pipeline lists 8 stages after typed tuple; code stops at stage 1–2 (types + structural admit).

## Verdict direction
Current variants work is a typed contract catalog + structural admission checker. It is not yet an autoresearch loop. Ten families before one executable evolving-intent paired study is premature. Dual TaskSpec vs Recipe models will fight every integration step.
