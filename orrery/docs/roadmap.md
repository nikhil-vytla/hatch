# Roadmap

Sequenced by leverage; each stage leaves the platform independently useful.

| Stage | Deliverable | Unlocks |
|---|---|---|
| v0 (done) | Deterministic kernel, verifier algebra, WorldSpec IR, procedural generation, chaos, replay, reference domain | Research platform; population QA for rule-based agents |
| v0.2 | `LLMPolicy` + LLM-judge verifier (ground-truth-aware); replay-with-recorded-decisions proven against live model runs | Evaluating real agents; Petri-style audits with ground truth |
| v0.3 | Dataset export (SFT pairs / RL trajectories filtered by contract); `orrery qa` CI gate; invariant-vs-objective reporting | Fine-tuning data + QA-at-release-speed (Snowglobe use case) |
| v0.4 | Benchmark adapters (one public agent benchmark → WorldSpec); streaming verification with early halt | Comparable numbers; long-timeline safety monitoring |
| v0.5 | T1 SDK adapters + T2 interception proxy (provider dialects at localhost) | Unmodified agent binaries as systems-under-test |
| v0.6 | Browser/desktop Surface (screenshot ImagePart observations, pointer intents); snapshot segments for long traces | Multimodal + computer-use agents |
| v1.0 | Risk-feedback generation loop (verdicts re-prioritize generator sampling); multi-run experiment manifests | Closed-loop coverage growth (Snowglobe's iteration, on real worlds) |

Standing constraints: kernel stays deterministic and single-writer; anything
nondeterministic lives behind the decision-recording boundary; every new
subsystem ships with property tests for its invariants.
