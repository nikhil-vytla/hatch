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

*(Revised 2026-08-06: this section originally over-claimed — "everyone else built
half of strive", "validate nothing", "strive's gated-loop bet is validated". Those
statements are corrected below; the underlying source notes were already accurate.)*

Six sources examined at pinned provenance (three repos at exact SHAs, one paper read
including appendices, one blog cluster, one repo+blog+paper cluster). The neutral
finding: **the researched systems occupy complementary parts of the design space**,
each optimizing different sub-problems under different constraints. strive's aim is
to test whether combining selected mechanisms from them — comparative promotion,
durable lineage, bounded online refinement — improves long-run performance; that
combination is strive's hypothesis, not an established result.

More precisely:
- **Flex/GEPA** does rigorous budgeted candidate validation and *can persist logs,
  checkpoints, and candidate programs*; what it lacks is strive's proposed
  deployment-level semantics — activation of a generation as the live incumbent,
  journaled rollback, and long-lived online generation lineage. It is an offline
  optimizer by design, not a deployment harness.
- **prime-agent, Continual Harness, and exo** persist and self-modify richly but have
  **no pre-activation, comparative behavioral promotion gate for harness
  refinements** — refinements go live without being behaviorally compared against the
  incumbent first. Each has *other* quality controls (prime-agent: typed edit
  validation, LLM review, invertible rollback; CH: behavioral triage and repair; exo:
  build gates and durable intents).
- **NOOA and RLM** contribute infrastructure patterns (kernel-level sandboxing,
  versioned trajectory schemas, bounded recursion with budget inheritance) rather
  than evolution loops.

The documented CH failures support *specific* mechanisms rather than gating in
general: the inherited-usage collapse to 6.4% with regression below baseline is
primarily evidence for **reuse/inheritance protection** (D6's replace-vs-add
thresholds); the 842-repetition stall from silent schema fallback is primarily
evidence for **loud schema rejection and trusted stall detection** (D9/D10). Neither
event directly demonstrates that a comparative promotion gate outperforms ungated
refinement overall — see "Evidence gaps".

Highest-value single source: arXiv:2605.09998 (note 03) — the only source with
empirical evidence on reset-free online adaptation, including the failure modes
strive's design must prevent and the capability-floor result (harness self-improvement
is net-negative below a model-capability threshold; a weak proposer must fail
*rejected*, not fail *degraded*).

## Why embedded acceptance gates are difficult — or deliberately omitted

The absence of promotion gates in the researched systems is not simple negligence.
Any fair comparison (and strive's own design) must account for why gates are hard:

- **Missing ground truth.** Most harness refinements (a better prompt note, a memory
  entry, a subagent spec) have no oracle to score against; "better" is only visible
  in downstream behavior.
- **Non-resettable environments.** Comparative evaluation wants A/B runs from the
  same state; CH's domain (and most long-running agents) cannot fork or reset the
  world, which is exactly why CH validates behaviorally after the fact.
- **Evaluation cost.** A gate that re-runs a suite per candidate multiplies compute;
  GEPA treats eval budget as the scarce resource for good reason.
- **Delayed benefits.** Some changes (memory writes, exploration-oriented policies)
  pay off many steps later; a gate scoring immediate deltas would reject them.
- **Cold start.** Early in a run there is no incumbent track record to compare
  against, and strict gates would freeze the system at its weakest point.
- **Goodhart risk.** A gate is itself a metric; optimizing candidates against it
  invites overfitting the gate rather than the task (strive's held-out discipline is
  a mitigation, not an immunity).
- **Product-layer boundaries.** Systems like exo and prime-agent deliberately keep
  evaluation semantics out of the substrate/product layer, leaving it to operators —
  a legitimate architectural choice, not an oversight.

strive's position: these difficulties shape *where and how much* evidence to demand
(hence D1's proportionality and D12's provisional online changes), they do not argue
for demanding none for durable promotions. Whether that position wins on long-run
performance is hypothesis H1.

## Architectural decisions (with evidence)

- **D1 (revised) — Promotion evidence is proportional to risk and evaluability.**
  Durable or broad-scope promotion requires trusted behavioral evidence; low-risk or
  online changes may activate provisionally — scoped, reversible, monitored, and
  expiring unless confirmed. LLM judgment and static checks are pre-filters, never
  the durable gate. The kernel enforces decision integrity and evidence integrity;
  it does not impose one universal metric policy — validators are pluggable per
  surface and risk tier (see D14). (Original D1 demanded uniform empirical validation
  for everything; revised per the gate-difficulty analysis above. Notes 02/03/04.)
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
- **D14 — Validators are per-surface, per-risk plugins; the kernel's invariant is
  that every promotion decision is journaled with the evidence that supported it and
  that evidence is computed trusted-side — not that every surface passes the same
  metric.** (Preserves the Validator design in ARCHITECTURE against collapsing into
  a single universal gate. Notes 01/03.)

## Evidence gaps (what the research could NOT establish)

- **Transfer beyond games:** CH's reset-free results are Pokémon-only; transfer to
  coding/research/tool agents is claimed, not demonstrated. strive stage 4–5 is
  effectively the missing experiment.
- **Gated vs ungated head-to-head:** no source compares an acceptance-gated refiner
  against an ungated one on the same stream (CH leaves reset-free-vs-batch open too).
  **Gated-vs-ungated superiority is therefore a strive hypothesis (H1), not a
  validated result** — the research established only that ungated systems exhibit
  specific failure modes that specific mechanisms (inheritance protection, schema
  rejection, stall detection) plausibly address, and those mechanisms do not require
  a full gate to deploy.
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

**Recommendation: proceed directly to Goal 3.** The epistemic correction above is
complete (synthesis claims neutralized, D1 revised to proportional evidence, D14
added, failure attributions tied to their specific mechanisms) and required no
runtime-code changes; nothing in the corrected synthesis invalidates the hardening
queue — items 1–6 serve the corrected decisions exactly as they served the original
ones.

Then: execute the hardening queue (items 1–6) and stage 2's model-in-the-loop work
(items 7–8) against ROADMAP stage-2 exit criteria: a model-backed proposer (fake model
in CI) fixes a non-planted weakness on a second task, passes held-out validation, and
the full cycle replays offline from the ledger alone.
