# ADR-0004 — Verifiers as composable trajectory predicates (LTL-lite)

**Status:** accepted · 2026-07-04

## Context

The brief: verifier-driven evaluation over brittle scoring; verification must
reason about trajectories, state transitions, safety, policy compliance,
robustness, resources, and multimodal outputs. Prior art scores samples
(Inspect scorers) or rewards rollouts (verifiers rubrics) — mostly output-shaped.

## Decision

A **Verifier** is `verify(trace, world_view) -> Verdict`. Verdicts are structured:
status (pass/fail/inconclusive), score in [0,1], and **evidence** — the event ids
that justify the verdict, so every judgment is auditable against the trace.

Composability comes from a small algebra:

- Boolean: `all_of`, `any_of`, `not_`, `weighted` (score aggregation).
- Temporal (LTL-lite over the event stream): `always(pred)`, `never(pred)`,
  `eventually(pred)`, `precedes(a, b)` — predicates are plain Python over events
  and reconstructed state, so anything expressible is checkable.
- Domain packs (safety, resource budgets, policy compliance) are just libraries of
  prebuilt predicates.

Verifiers read **ground-truth world state** (via replayed folds), not just the
transcript — an LLM judge is one Verifier implementation among many, and even it
gets the ground truth to grade against.

A WorldSpec **co-declares its contract** (invariants + objectives), so generation
and evaluation share one source of truth.

## Alternatives considered

- *Full LTL/CTL model checking* — heavy formalism, poor ergonomics for Python
  predicates; we keep the operators, drop the model checker.
- *Reward functions only* — scalar rewards erase evidence and compose poorly for
  safety claims ("0.7 safe" is meaningless; "violated invariant X at event 143"
  is actionable).

## Consequences

- Post-hoc verification over traces in v0; the interface permits streaming
  verification later (same predicates, incremental fold).
- Evidence-carrying verdicts make failure triage and dataset filtering
  (export only trajectories passing contract X) trivial.
