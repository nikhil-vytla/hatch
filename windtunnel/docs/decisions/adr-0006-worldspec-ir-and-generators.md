# ADR-0006 — WorldSpec IR with pluggable generators

**Status:** accepted · 2026-07-04

## Context

"Generate rich executable worlds from high-level descriptions" invites an
LLM-in-the-kernel design, which would make every run non-auditable and every test
need network. Bloom's lesson: generated suites are fine iff citable/reproducible.

## Decision

Split generation from execution with a declarative intermediate representation:

- **WorldSpec** (Pydantic, TOML-serializable): entities, actors + roles + policies,
  timeline (scheduled events/perturbations), stochasticity knobs, and the verifier
  contract (invariants + objectives). The spec is hashable → citable.
- **Generator protocol:** `generate(brief, seed) -> WorldSpec`. v0 ships (a) TOML
  loading (hand-written specs) and (b) a seeded procedural generator (template
  expansion + seeded sampling of entities/personas/perturbations). An LLM compiler
  is a future generator plugin; its *output* is still an auditable WorldSpec.
- The kernel executes only WorldSpecs. Nothing executes prose.

## Alternatives considered

- *LLM builds the world directly in context* (Petri-style) — no ground truth, no
  reproducibility; rejected as core (fine as a generator plugin later).
- *Worlds as arbitrary Python modules only* (Inspect/verifiers-style) — maximally
  expressive but opaque: can't diff, mutate, or procedurally sample them. We keep
  a Python escape hatch (custom reducers/policies register by name) while the
  topology stays declarative.

## Consequences

- Population-scale QA (Snowglobe use case) = sample N seeds → N WorldSpec
  variants → run → filter by contract. Every artifact in that pipeline is
  inspectable text.
- Benchmark adaptation = writing a converter from the benchmark's task format to
  WorldSpec, one-time per benchmark.
