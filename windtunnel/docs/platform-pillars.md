# Platform pillars: RL, sandboxing, tracing, observability

Status and staged design for the four infrastructure pillars, written in
response to a direct planning check (2026-07-04). Summary table first;
details and alternatives below.

| Pillar | Today | Next slice | End state |
|---|---|---|---|
| RL / training data | ✅ contract-labeled SFT export (`export.py`); reward = objectives gated by invariants | structured chat turns + per-policy renderers | token-faithful rollout server for RL trainers (prime-rl/TRL-compatible) |
| Sandboxing | ⬜ not needed yet (all tools simulated in-process); risk documented | `Runtime` protocol + subprocess runtime for code-execution tools | container/remote runtimes; sandboxed T2 proxy; `uses` allowlist |
| Tracing | ✅ the core artifact: hash-chained events, recorded decisions, replay, tamper detection | fold==final_state check on read; first-divergence diff | segmented traces + snapshots; prefix-collapsed message graph for LLM context reuse |
| Observability | 🟡 structured JSON logs + `DecisionObserver` hook | OTel spans over the engine loop; trace→OTLP converter | `windtunnel report` HTML; live run dashboards fed by the observer seam |

## RL / training data

**Position: Windtunnel is the environment side of RL, never the trainer.** We
produce worlds, rollouts, and verifier-derived rewards; PPO/GRPO/DPO live in
prime-rl, TRL, or whatever the researcher runs. The interface between the
two is the trace.

**Built now (first slice):**
- `DecisionObserver` — an engine hook firing identically in live and replay
  runs with (actor, activation, observation, decision).
- `export.py` — traces → policy-agnostic (observation, decision) records.
  Observations are **reconstructed by replay**, not stored: the trace stays
  lean, and ADR-0001 guarantees the reconstruction is bit-faithful to what
  the actor saw. Rejected alternative: persist observations in the trace —
  redundant (derivable), bloats every run for the minority that get exported.
- **Reward = the contract.** `reward_summary` aggregates objective scores and
  gates them on invariants: a run that resolves the ticket but leaks the
  secret exports with reward 0.0. Verifier-driven labeling was the point of
  ADR-0004; this is it paying off — no hand-written reward functions.
- `windtunnel export spec trace --out data.jsonl`, with `require_pass`
  contract-filtering for imitation data.

**Staged plan:**
1. *Structured turns (M3).* ModelPolicy history becomes structured
   (tool_use/tool_result blocks), each client renders natively; chat-format
   SFT becomes a renderer over export records.
2. *Token fidelity (M4+).* For RL you must train on exactly the tokens the
   model saw — verifiers v1's token invariant. Requires clients that return
   token ids (`TrainClient` analogue) and export that preserves them. We will
   not fake this with re-tokenization; until then Windtunnel advertises SFT-grade
   export only.
3. *Rollout service (with T2).* An environment server speaking
   verifiers-style rollout APIs so trainers drive Windtunnel worlds directly:
   `reset(spec, seed) / step` is a thin façade over the scheduler; branching
   rollouts map onto replay-to-event-k + fresh streams (the counterfactual
   machinery from ideas.md).

## Sandboxing

**Position: sandboxing is a *tool/runtime* concern, not a kernel concern —
and v0 genuinely doesn't need it.** Every capability today is simulated:
tools are pure functions (or canned data) over the entity store. There is no
file system, no network, no subprocess anywhere in a world. The honest risk
register instead of theater:

- `uses` imports arbitrary Python (debt #9) — acceptable for a local research
  tool, needs an allowlist the day specs arrive from strangers.
- Policies run in-process and may do I/O by design (their outputs are
  quarantined by decision recording — a *determinism* boundary, not a
  *security* boundary; a malicious policy could still read your disk).

**Staged plan (aligned with what forces each stage):**
1. *`Runtime` protocol + subprocess runtime* — forced by the first
   code-execution domain (coding worlds where the agent's program actually
   runs). A tool implementation gains `runtime: subprocess` with rlimits;
   the ToolFn signature is unchanged, so worlds don't know.
2. *Container/remote runtimes* — forced by untrusted agent code at scale;
   same protocol, verifiers-v1-style (subprocess/Docker/remote as peers),
   with error attribution so sandbox failures aren't blamed on agents.
3. *Sandboxed T2 proxy* — when unmodified agent binaries connect via the
   interception endpoint (ADR-0005), the binary itself runs in the container;
   the proxy is the only egress. This is where security and ingestion tiers
   converge.

Rejected alternative: sandbox-first design (Inspect ships sandboxing early).
Right call for their threat model (arbitrary eval code from day one); wrong
for ours — we'd have paid container overhead on every simulated-tool run and
learned nothing until real code execution exists.

## Tracing

**Position: already the load-bearing pillar** — the trace *is* the product
(ADR-0001): meta (spec hash, seed, version), hash-chained events, recorded
decisions, final state; JSONL on disk; replay with `ReplayDivergence` on
tamper; every verifier verdict cites event ids into it.

**Known gaps and their fixes (mostly debt items):**
- `fold(events) == final_state` isn't asserted on read (debt #3-adjacent) —
  a lying `final_state` would go unnoticed by `windtunnel verify`. Cheap fix, do
  at M3.
- Divergence is detected, not explained — add first-divergent-event diff.
- No segmentation/snapshots for very long timelines (debt #7): plan is
  segment files + periodic state snapshots so replay-to-t and export don't
  refold from genesis.
- For LLM-heavy multi-agent runs, the verifiers-v1 prefix-collapsed message
  graph is the eventual answer to quadratic context storage; our events
  generalize their messages, so this is an optimization layer, not a schema
  break.

## Observability

**Position: two channels with distinct jobs — logs are diagnostics, the
trace is truth; observability tooling should *derive from the trace* rather
than grow a third source.**

**Today:** structured JSON logs to stderr (namespaced, `WINDTUNNEL_LOG_LEVEL`),
run summaries with verdict maps, and — new — the `DecisionObserver` seam, so
external consumers can watch activations live without touching the kernel.

**Staged plan:**
1. *OTel spans (M3, debt #6).* Instrument the engine loop — run → activation
   → decide/submit/reduce — behind an optional exporter; call sites
   unchanged. Virtual time goes in span attributes (wall time on spans,
   virtual time as data — they must not be conflated).
2. *Trace→OTLP converter.* Because the trace is complete, any APM can render
   a finished run without having watched it live: events become span events,
   actors become resources. `windtunnel otel trace.jsonl` batch-exports.
3. *`windtunnel report`.* Static HTML per run/population: timeline lanes per
   actor, verdict table with evidence links, chaos windows shaded. Derives
   entirely from (spec, trace, verdicts).
4. *Live dashboards* ride the observer hook plus a streaming-verifier fold —
   same predicates, incremental evaluation, alert on first invariant breach.
