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

## M2 — Provider integration + benchmark adaptation (done, 2026-07-04)

Prompted by a direct ambition check: "how easy is it to bring in different
agents/models/providers, and can we adapt existing benchmarks?" Both were
architecture claims without proof; this milestone made them capabilities.

**What was built.**
- `models.py` (ADR-0007): `ModelClient` protocol (one async `complete()`
  method = a provider), `ModelPolicy` (any chat+tool-calling model as an
  actor; tool calls → intents; the kernel's event loop is the agentic loop),
  `AnthropicClient` (lazy optional dep) and `PlaybookClient` (deterministic
  test double / reference adapter).
- `adapters.py` (ADR-0008): adapter protocol `(rows, brief) -> [WorldSpec]`
  with a `bfcl_style` function-calling adapter; **tools-as-data** (canned
  `response` on tool entities → adapted specs are pure data, `uses=[]`);
  **oracle self-validation** (default agent performs the task's expected
  actions, proving each conversion is solvable); `orrery adapt … --run` CLI.
- Dynamic worlds: `spawn_entity`/`despawn_entity` mechanics — timelines and
  actors can grow the world mid-run, with growth in the event log so replay
  and verifiers see it.

**Key verified behaviors** (now 32 tests):
- a model-driven agent passes the support-desk contract; the SUT swap is a
  policy-spec change, no world changes
- replaying a model-driven trace against a client that raises on contact
  succeeds — replay provably never touches a provider
- every adapted benchmark task is validated by its oracle; the same task runs
  against a model policy; a wrong-args call fails exactly its expected-call
  objective while `responded_to_user` still passes
- a timeline-spawned entity exists in final state and replays bit-for-bit

**Deferred within M2 scope:** the LLM *judge* verifier (ground-truth-aware
grading) — moved to M3, since the verifier slot and omniscient store access
already exist.

## Next milestones (proposed order)

- **M3 — LLM judge verifier + dataset export + QA gate.** Judge grades with
  ground-truth world access; trace → (observation, decision) SFT/RL examples
  filtered by contract; invariant-vs-objective rollup in reporting.
- **M4 — Stateful benchmark adapter (τ-bench-style).** Reactive scripted
  users + DB-entity initialization; `matches_any` arg-matching for BFCL
  answer ranges.
- **M5 — T2 interception proxy.** Provider-dialect localhost endpoint so
  unmodified agent binaries run inside Orrery worlds.
