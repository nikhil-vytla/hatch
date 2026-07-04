# Milestones

## M0 — Research & design (done, 2026-07-04)

Grounding pass over Snowglobe, PI verifiers v1, Inspect AI, Petri/Bloom, and
chaos-engineering practice (`research.md`); Unknowns Discovery (`assumptions.md`);
six ADRs locking the kernel decisions.

## M1 — Deterministic kernel + reference world (done, 2026-07-04)

**What was built.** The full v0 vertical slice:
event-sourced world, discrete-event virtual time, named RNG streams,
actor/policy/surface/observation-policy abstractions, chaos-as-actor,
hash-chained traces with recorded decisions, replay with divergence detection,
LTL-lite verifier algebra with evidence-carrying verdicts, WorldSpec IR
(TOML + JSON), procedural generator, plugin registry, structured logging, CLI,
and the support-desk reference domain (hidden fraud flag, seeded tool outage,
five-item contract). 23 tests (property-based where it matters) + ruff +
pyright standard, all green.

**Why this design.** See ADRs 0001–0006. The one-sentence version: every
requirement in the brief (multi-agent, hidden state, chaos, reproducibility,
verifier-driven evaluation, modality growth) collapses into four orthogonal
concepts — event-sourced world, universal actors, filtered observation,
trace-level verification — if and only if determinism is pushed to the
boundary (record live decisions, replay them exactly).

**Alternatives rejected along the way.** Gym-style step loops (single-agent
bias), LLM-in-the-kernel generation (unauditable), reward scalars (no
evidence), tick-based time (O(simulated time)), mutable world + snapshots
(replay archaeology). Details in the ADRs.

**Verified behaviors** (each is a test, not a claim):
- same seed ⇒ bit-identical event fingerprint; different seeds diverge
- replay reproduces the fingerprint; a tampered decision stream is detected
- the leak-variant agent fails `no_secret_leak` with the exact guilty event id,
  while unrelated contract items still pass (attributed failure)
- chaos windows force retries on some seeds and the agent still resolves
  (robustness objective under fault injection)
- secret attributes never render into an uncleared actor's view

**Assumptions / open questions.** Carried in `assumptions.md` (notably U3
parallel policy evaluation, U6 streaming surfaces, U7 T2 interception proxy).

**Technical debt.** Logged in `technical-debt.md`.

## Next milestones (proposed order)

- **M2 — LLM-backed actors + judge verifier.** An `LLMPolicy` (Claude API)
  behind the same Policy protocol, proving decision-recording keeps replay
  intact with a nondeterministic live actor; an LLM judge Verifier that grades
  with ground-truth world access. Highest leverage: it converts the framework
  from "simulator" to "evaluation product".
- **M3 — Dataset export + QA gate.** Trace → (observation, decision) SFT/RL
  examples filtered by contract; `orrery qa` exit-code gate for CI.
- **M4 — Benchmark adapter.** One converter (e.g. τ-bench-style support tasks)
  from a public benchmark format into WorldSpecs, validating ADR-0006's
  adaptation claim.
- **M5 — T2 interception proxy.** Provider-dialect localhost endpoint so
  unmodified agent binaries run inside Orrery worlds.
