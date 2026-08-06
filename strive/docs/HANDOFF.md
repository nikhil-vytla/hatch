# HANDOFF — strive

State as of 2026-08-06, after two phases: the vertical slice (stage 1) and the
research-and-redesign phase (notes 01–06, [comparative matrix](agents/research/comparative-matrix.md),
[ARCHITECTURE](ARCHITECTURE.md), [ROADMAP](ROADMAP.md)).

## What works (unchanged from phase 1)

- Full gated loop end to end: execute → observe → evaluate → diagnose → propose →
  validate → accept/reject → retain, over executable strategy code in a subprocess
  with a hard timeout. 23 offline tests, strict mypy, committed demo lineage with
  restart persistence and rollback (`artifacts/demo/transcript.txt`).

## Research conclusions

Six sources examined at pinned provenance (three repos at exact SHAs, one paper read
including appendices, one blog cluster, one repo+blog+paper cluster). The one-line
synthesis: **everyone else built half of strive.** Flex/GEPA has rigorous validated
candidate generation but no durable lineage or rollback; prime-agent, Continual
Harness, and exo have rich persistence and self-modification but no empirical
acceptance — and the consequences are documented, not hypothetical (CH's inherited-
usage collapse to 6.4% with regression below baseline; CH's 842-repetition stall from
silent schema fallback; exo's own docs admitting the missing clone-and-compare path).
NOOA and RLM contribute infrastructure patterns (kernel-level sandboxing, versioned
trajectory schemas, bounded recursion with budget inheritance) rather than evolution
loops. strive's gated-loop bet is validated; its v0 mechanics are what need to grow.

Highest-value single source: arXiv:2605.09998 (note 03) — the only source with
empirical evidence on reset-free online adaptation, including the failure modes
strive's design must prevent and the capability-floor result (harness self-improvement
is net-negative below a model-capability threshold; a weak proposer must fail
*rejected*, not fail *degraded*).

## Architectural decisions (with evidence)

- **D1 — Validation is empirical and trusted-side; LLM judgment and static checks are
  pre-filters only.** (prime-agent's unvalidated /refine; exo's build-success gate;
  CH's ungated drift. Notes 02/03/04.)
- **D2 — Trust boundaries are mechanisms, never policy/config.** Evolvable artifacts
  never enter the kernel process. (exo RSI.md fn.2 anti-pattern; NOOA guardrails-vs-
  boundary doctrine. Notes 04/06.)
- **D3 — All metrics, scores, and budget accounting are computed on the trusted
  side.** (exo cost doc: agent-reported usage is untrustworthy. Note 04.)
- **D4 — Evaluator contract is `(score, feedback_text)` with failure-as-score floor
  semantics.** (GEPA metric contract. Note 01.)
- **D5 — Generations become composite: per-surface CRUD deltas with before/after
  snapshots; per-surface activation and rollback.** (prime-agent edit schema × CH's
  four-surface decomposition. Notes 02/03.)
- **D6 — Acceptance gains held-out discipline and inheritance-aware thresholds
  (replace-vs-add).** (Reward-hacking risk from phase 1 + CH bootstrap regression.
  Note 03.)
- **D7 — Budgets are part of the cycle contract, hierarchical (children inherit
  remaining budget).** (RLM. Note 05.)
- **D8 — Sandbox is a tier registry behind one interface: subprocess → rlimits/no-net
  → Landlock+seccomp (Linux) → container.** (RLM ladder; NOOA guards. Notes 05/06.)
- **D9 — The runner rejects loudly on schema mismatch; silent fallback is forbidden.**
  (CH's 842-repetition stall. Note 03 §B.3.)
- **D10 — Trusted mechanical stall/drift monitors (identical-outcome counters,
  inherited-usage share) live in the kernel and can freeze adaptation.** (CH: self-
  diagnosis is confidently wrong during stalls. Note 03.)
- **D11 — All model I/O journaled and replayable; deterministic fake adapter in core;
  tests offline forever.** (NOOA FakeLLMClient precedent. Note 06.)
- **D12 — Online adaptation = provisional activations + proxy validators + inheritance
  protection + offline confirmation; online-adaptable surfaces are an allowlist subset.**
  (CH's evidence that proxies work and that ungated permanence drifts. Note 03.)
- **D13 — Durable side effects are intent-journaled before execution.** (exo guardian
  pattern. Note 04.)

## Evidence gaps (what the research could NOT establish)

- **Transfer beyond games:** CH's reset-free results are Pokémon-only; transfer to
  coding/research/tool agents is claimed, not demonstrated. strive stage 4–5 is
  effectively the missing experiment.
- **Gated vs ungated head-to-head:** no source compares an acceptance-gated refiner
  against an ungated one on the same stream (CH leaves reset-free-vs-batch open too).
  This is strive hypothesis #1 (note 03).
- **Proxy-validator fidelity:** CH shows oracle-relative proxies track improvement but
  never tests whether proxy-gated acceptance agrees with full-suite acceptance.
- **Pareto retention under lineage constraints:** GEPA's frontier retention was only
  studied without durable lineage/rollback; whether frontier members remain useful as
  journaled generations is untested.
- **Blog-sourced numbers** (note 01) were extracted via fetch tooling and not
  independently reproduced.
- **Repo snapshots age:** all three repos were inspected at single SHAs on 2026-08-06;
  conclusions about "what X lacks" may rot.

## Exact hardening priorities (ordered; this is the stage-2 work queue)

1. **Typed codec + versioned schemas** for ledger and events, with normative tests
   (eliminates the phase-1 dict-drift debt; prerequisite for composite generations).
2. **Task-owned scoring with visible/held-out splits**; `decide` requires held-out
   improvement (closes the phase-1 overfitting risk before any model proposer exists).
3. **Evaluator contract → (score, feedback) + failure-as-score** (D4).
4. **Loud schema rejection + trusted stall detector** (D9, D10 — cheap now, structural
   later).
5. **Budget plumbing in the cycle contract** (D7 — retrofitting budgets later touches
   every interface; do it while there are five).
6. **Usage accounting in the ledger** (D5 prerequisite; one field now, drift telemetry
   forever).
7. **Proposer/Validator protocols + FakeModelAdapter** (the model-in-the-loop seam,
   D1/D11).
8. **Sandbox tier 2** (rlimits + network denial; D8).

Items 1–6 are pure hardening of existing code; 7–8 open stage 2 proper. Nothing in
the queue requires a network or a real model.

## Unresolved risks (carried forward, sharpened)

- **Reward hacking / eval overfitting** — now has a concrete mitigation design
  (held-out splits, D6) but no implementation; remains the top risk once a model
  proposer lands.
- **Trust-boundary erosion** — the charter forbids evolving the evaluator; D2 makes
  the boundary mechanical, but the independent-check design for ever evolving trusted
  surfaces still does not exist.
- **Capability floor** — stage-2 gains will be proposer-model-dependent; the danger
  signature (rising acceptance rate with falling held-out score) must be monitored
  from the first model-backed cycle (note 03 implication 7).
- **macOS sandbox ceiling** — Landlock/seccomp are Linux-only; local development rides
  tier 2 (rlimits) until containers arrive in stage 6.

## Next phase

Execute the hardening queue above (items 1–6), then stage 2's model-in-the-loop work
(items 7–8) against ROADMAP stage-2 exit criteria: a model-backed proposer (fake model
in CI) fixes a non-planted weakness on a second task, passes held-out validation, and
the full cycle replays offline from the ledger alone.
