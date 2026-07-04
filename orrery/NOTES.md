# NOTES — Orrery

Working log for the agent-simulation framework experiment. Newest entries at the bottom.

## 2026-07-04 — Kickoff

Goal: a next-generation simulation & environment-generation framework for evaluating,
training, and stress-testing autonomous AI agents. "Unreal Engine for agent environments."

Name candidates considered: `holodeck` (overused), `crucible` (stress-test flavored but
generic), `terrarium` (taken by other projects), `demiurge` (pretentious), **`orrery`** —
a mechanical model of a planetary system: a small, precise, inspectable machine that
simulates a much larger world. Picked `orrery`.

Plan of attack:
1. Grounding research pass on the four inspiration systems (Snowglobe, PI Verifiers,
   Inspect AI, Petri) — capture what each got right/wrong in docs/research.md.
2. Unknowns Discovery: enumerate the hard design questions BEFORE choosing abstractions
   (docs/assumptions.md + ADRs for the big calls).
3. Design the kernel: smallest set of orthogonal concepts that cover the requirements.
4. Implement kernel + one end-to-end demo world + verifier suite + property tests.
5. Document, report, commit.

Constraints from the brief I'm treating as hard requirements:
- deterministic replay / reproducible seeds / no hidden randomness
- multi-agent as first-class (not a wrapper)
- verifier-driven evaluation (trajectory-level, composable), not string matching
- hidden state + partial observability per agent
- long-running timelines + configurable stochasticity + chaos injection
- modality-agnostic interaction surfaces (text now; browser/audio/embodied later must
  fit the same abstraction without redesign)
- uv, Ruff, Pyright, Pydantic v2, async, structured logging, TOML config,
  property-based testing, plugin discovery

## Research pass (done)

Fetched Snowglobe overview, verifiers README + v1 ARCHITECTURE.md, Inspect README,
petri_bloom README. Full extraction in docs/research.md. Biggest finds:
- verifiers v1's interception architecture (harness points its native SDK at a
  localhost proxy; framework invisible behind it) is the right answer to "ingest
  arbitrary agent SDKs". Steal this as the long-term ingestion story.
- Trace-as-message-graph with prefix collapsing + token invariant: right shape for
  the canonical artifact; we generalize messages → world events.
- Petri's key weakness: environment faked in-context by the auditor → judges have
  no ground truth. A real world model with hidden state fixes this. That's our
  differentiator #1.
- Snowglobe's risk-feedback loop (results reprioritize persona generation) is a
  v2 feature — noted in ideas.md, not core.
- Chaos engineering: perturbation = scheduled experiment with hypothesis
  (steady-state invariant), not random noise. Maps perfectly onto timeline events
  + always-verifiers.

Key synthesis decision forming: **everything is an actor** (agent-under-test, NPC
personas, auditors, chaos daemons) on an **event-sourced world** with **per-actor
observation policies** (hidden state), **virtual time**, and **verifiers over the
trace**. Next: unknowns discovery before freezing these.

## Unknowns discovery + ADRs (done)

Ten unknowns worked through in docs/assumptions.md. The one that unlocked
everything: U1 — the determinism boundary. You cannot make LLM actors
deterministic, so don't try; make the *world* a pure function of
(spec, seed, decision stream) and record decisions. Everything else
(replay, citability, counterfactual branching later) falls out. Froze six
ADRs (event-sourced kernel; everything-is-an-actor; virtual time + named RNG
streams; verifiers as trajectory predicates; surfaces/observation
policies/ingestion tiers; WorldSpec IR + generators).

## Implementation log

- Scaffolded with `uv init --lib`; pydantic v2 only runtime dep; dev: pytest,
  pytest-asyncio, hypothesis, ruff, pyright.
- Kernel modules in dependency order: ids → rng → content → events/entities →
  clock → observe → world → surfaces → actors → perturb → trace → verify →
  spec → plugins → generate → engine → logging → cli. No circular imports.
- Registries are per-run objects (plugins.Registry), not module globals —
  the "no global mutable state / no singletons" constraint shaped this early
  and it paid off immediately in tests (isolated registries per test).
- Chaos daemon design worked out nicely: it *decides* its outage window once
  (drawn from its own stream) and commits via scheduled intents; replay
  reproduces the window because the decision is recorded. Chaos events are
  visibility="direct" so the agent can't see them — only their effects.
- First end-to-end run: 5/5 seeds passed, seeds 1–2 showed 6 tool calls
  (outage → retries) vs 2 on quiet seeds. Chaos + robustness working as
  designed on the first execution — the event-sourced discipline made the
  whole pipeline click together with zero debugging of the kernel itself.
- Leak-variant agent (brief {"leak_secret": true}) fails exactly the
  no_fraud_leak invariant with the guilty event id as evidence; other
  contract items keep passing. Attributed failure > scalar score, confirmed.
- Replay: `orrery replay` reproduces the fingerprint bit-for-bit; tampering
  with one recorded decision triggers ReplayDivergence (tested).
- Gotchas hit:
  - zsh eats `echo ===` (harmless; command chain, not code).
  - Pyright correctly demanded Sequence (covariance) in combinator
    signatures — nice API improvement, applied.
  - Kept `no_secret_leak` value-needles to len>3 *strings* only; "True"
    would substring-match ordinary prose. Logged as debt (LLM judge is the
    real fix).
- Final quality gate: ruff clean, pyright standard 0 errors, 23/23 tests
  (hypothesis property tests over rng independence, scheduler total order,
  verifier algebra laws; e2e determinism/replay/chaos/safety tests).
- Demo artifacts in examples/ (spec-seed1.json + support_desk-1.jsonl),
  replay-verified after regeneration.
