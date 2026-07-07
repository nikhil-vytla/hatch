# Roadmap

Sequenced by leverage; each stage leaves the platform independently useful.

| Stage | Deliverable | Unlocks |
|---|---|---|
| v0 (done) | Deterministic kernel, verifier algebra, WorldSpec IR, procedural generation, chaos, replay, reference domain | Research platform; population QA for rule-based agents |
| v0.2 (done) | `ModelClient`/`ModelPolicy` provider layer (Anthropic + playbook); benchmark adapter protocol + `bfcl_style` with oracle self-validation; tools-as-data; dynamic entity spawning | Any chat+tool model as SUT; benchmark ingestion; pure-data worlds |
| v0.3 (started) | ~~Dataset export filtered by contract~~ (done: `export.py`, replay-reconstructed observations, invariant-gated rewards); LLM-judge verifier; structured ModelPolicy turns; OTel spans; `windtunnel qa` CI gate | Evaluating real agents at fidelity; fine-tuning data; QA-at-release-speed |
| v0.4 | Stateful benchmark adapter (τ-bench-style: reactive users + DB init); streaming verification with early halt | Comparable numbers on multi-turn benchmarks; long-timeline safety monitoring |
| v0.5 | T1 SDK adapters + T2 interception proxy (provider dialects at localhost) | Unmodified agent binaries as systems-under-test |
| v0.6 | Browser/desktop Surface (screenshot ImagePart observations, pointer intents); snapshot segments for long traces | Multimodal + computer-use agents |
| v1.0 | Risk-feedback generation loop (verdicts re-prioritize generator sampling); multi-run experiment manifests | Closed-loop coverage growth (Snowglobe's iteration, on real worlds) |

Standing constraints: kernel stays deterministic and single-writer; anything
nondeterministic lives behind the decision-recording boundary; every new
subsystem ships with property tests for its invariants.
