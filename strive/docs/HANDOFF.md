# HANDOFF — strive

State as of 2026-08-07, after four phases: the vertical slice (stage 1), the
research-and-redesign phase (notes 01–06, [comparative matrix](agents/research/comparative-matrix.md),
[ARCHITECTURE](ARCHITECTURE.md), [ROADMAP](ROADMAP.md)), the phase-3 hardening
of the core harness (stage 2a), and the phase-4 model-backed offline
self-evolution loop (stage 2b).

## Phase 4 — model-backed offline evolution (what was implemented)

- **Pluggable proposal pipeline.** Typed `Proposer` protocol
  (`propose(ProposalRequest) -> ProposalResult`); the deterministic
  `RegistryProposer` retained as reference; `ModelProposer` over the
  provider-neutral `ModelAdapter`. Proposers are side-effect free: the kernel
  screens, retains, validates, and promotes.
- **Trusted, visible-only proposer inputs.** `ProposalRequest` carries the
  incumbent source, task signature + primitive catalog, visible failing cases
  with evaluator feedback, the diagnosis, sanitized acceptance history
  (aggregate scores and policy identity only — decision *reasons* are excluded
  because they can cite hidden-split case ids), and explicit budgets
  (max output tokens, model calls remaining, executions remaining). The spy
  test asserts no hidden case id or input text reaches the request *or the
  built prompt*.
- **Structured proposal schema** (`proposal@1`): parent generation, summary,
  rationale, trace evidence, expected outcome, complete candidate source,
  changed surfaces, risks, assumptions. Completions are validated strictly and
  rejections journaled by distinct kind: `proposal-truncated` (hit token cap),
  `proposal-malformed` (not JSON), `proposal-schema-invalid` (wrong shape,
  wrong parent echo, wrong surfaces), `proposal-forbidden` (kernel AST screen:
  imports outside the task catalog, forbidden builtins, unparseable source),
  `proposal-stale`, `budget-exhausted`, `model-error`.
- **Staleness protection.** The kernel re-reads the active generation after
  the proposer returns; a proposal parented on a superseded generation is
  rejected (`proposal-stale`) — tested with a proposer that changes the
  incumbent mid-proposal.
- **Journaled, replayable model I/O.** `model_call` events carry adapter name,
  model id, request parameters (max tokens, temperature, seed), token usage,
  latency, and content-addressed prompt/completion refs in the object store.
  `strive replay RUN_ID` re-executes baseline + candidate from recorded state
  and re-runs the recorded policy, reporting whether the decision reproduces —
  no proposer or model is consulted.
- **Second task, non-planted weakness.** `max-integers`: the seed takes
  `max()` over token *strings* (lexicographic — "9" beats "100"). No registry
  entry knows it; a control test proves the registry proposer cannot fix it.
  The generic `EvidenceDiagnoser` (registry-free) packages visible failure
  evidence; the model path proposes the numeric-comparison fix, which passes
  the paired gate 0.500 → 1.000 with zero regressions.
- **Real adapter, env-only.** `STRIVE_MODEL_PROVIDER=openai-compatible` +
  `STRIVE_MODEL_BASE_URL`/`STRIVE_MODEL_API_KEY`/`STRIVE_MODEL_ID` builds a
  stdlib-only adapter. Nothing in tests or default commands touches it.
- **CLI.** `strive run --proposer {registry,model}` (model uses the offline
  fake unless env-configured); `strive inspect --run ID --type model_call`
  filters journaled model/proposal events; `--json` everywhere.

## Phase-4 verification evidence

- `uv run pytest -q` → **91 passed**, offline. The demonstration matrix:
  fake-model fix of the non-planted weakness promoted through
  `paired-deterministic@1` on protected splits; registry control cannot fix
  it; full offline replay reproduces the decision; malformed / truncated /
  schema-invalid / forbidden responses each rejected with their distinct kind
  and no controller crash; regressive-but-valid candidate rejected with the
  incumbent left active and the rejection retained; stale proposal rejected
  after incumbent change; model-call budget enforced by the trusted meter
  (`model_call_denied` journaled, model never invoked); all stage-2a
  failure-injection tests and the phase-1 slice intact.
- `uv run mypy` → strict, no issues in 33 source files.
- `artifacts/demo-model/transcript.txt` → live CLI evidence: model-proposer
  cycle (fake adapter) accepted 0.500 → 1.000; exact replay with
  `decision_reproduced=True`; `inspect --type model_call` showing adapter,
  model id, latency, and the content-addressed prompt ref.

## Phase-4 decisions

- Decision reasons are excluded from proposer history (they may cite hidden
  case ids); history carries aggregate scores + policy identity only.
- The forbidden-source screen is kernel-side and runs *after* staleness,
  *before* any sandbox execution; it is a pre-filter (D1), never the gate.
- The fake adapter's demo responder parses the prompt (parent id, cited
  cases) rather than being keyed to exact prompt bytes — prompt evolution
  doesn't silently break the fixtures, and the fixture's role as a stand-in
  is explicit (`fakemodel.py` docstring).
- `EvidenceDiagnoser` names no weakness (`visible-case-failures`) — the
  CH lesson about confidently-wrong self-diagnosis argues for packaging
  evidence over guessing causes when no signature matches.

## Model-dependence limitations (stated plainly)

- **The CI "model" is a deterministic fake.** Every green test proves
  pipeline correctness — validation, gating, journaling, replay — and nothing
  about real-model proposal quality. The one honest capability claim: the
  *harness* correctly promotes good candidates and rejects bad, stale,
  malformed, forbidden, and over-budget ones, wherever they come from.
- **Real-model behavior is untested** and expected to be sharply
  capability-dependent (note 03's capability floor). The danger signature to
  watch when real runs begin: rising acceptance rate with falling held-out
  scores. Raw telemetry for this is journaled; the aggregated per-model
  statistics report is stage-3 work.
- **Single model call per cycle, no retry/repair loop:** a real model that
  emits one malformed response simply loses the cycle. Deliberate for now —
  retries interact with budgets and belong with evolution algorithms (stage 3).
- The isolation caveats from phase 3 stand; kernel confinement should precede
  any third-party candidate source.

## Next phase — stage 3: composite generations, pluggable validators, competing evolution algorithms

1. **Composite multi-surface generations**: per-surface CRUD deltas with
   before/after snapshots (D5); prompts and policies become surfaces; the
   `SurfaceDescriptor` registry.
2. **Pluggable `Validator` contracts**: suite / held-out / static tiers become
   registered validators chosen per surface and risk (D14); regression split
   grown automatically from past failures.
3. **Competing `EvolutionAlgorithm` plugins**: incumbent hill-climb (today's
   behavior) vs GEPA-style Pareto-frontier population under equal budgets,
   with per-algorithm and per-proposer-model acceptance statistics.
4. Sandbox tier 3 on Linux (Landlock/seccomp) ahead of any real-model
   candidate source used routinely.

## Phase 3 — hardened core (what was implemented)

The full gated loop still runs end to end, now on durable foundations:

- **Contracts + codec**: every persisted record is a versioned typed dataclass
  (`contracts.py`) serialized by one shared strict codec (`codec.py`). Unknown
  kinds, unsupported versions, missing/extra fields, and wrong types are
  rejected loudly; a golden v1 record is pinned by test so shape changes force
  version bumps.
- **Durable history**: append-only ledger with single-write+fsync appends;
  promotion is atomic by construction (one activation line); a torn final line
  is tolerated as a crash artifact while interior corruption is a loud
  `LedgerError`; strategy sources live in a content-addressed object store
  verified on every read; rollback/freeze/expiry are journal entries — nothing
  is ever deleted.
- **Task-owned scoring with splits**: visible / held-out / regression /
  adversarial. Diagnosis and proposal receive a `VisibleContext` that
  mechanically contains only the visible split (spy-tested); acceptance sees
  everything.
- **Failure-as-data**: crashes, hangs, output floods, malformed output,
  schema mismatches, and budget exhaustion all become recorded evaluation
  outcomes with floor scores. The controller never raises for candidate
  behavior.
- **Trusted accounting**: kernel-side `BudgetMeter` for wall time, executions,
  model calls, tokens, output bytes, cost, recursion depth; enforcement
  returns recorded failures. Usage attribution: every execution event names
  the generation that served it.
- **Trusted stall detection**: N flat failing cycles → journaled
  `stall-freeze`; adaptation halts, evaluation continues; operator `resume`
  lifts it. Healthy idling (score 1.0) never freezes.
- **Pluggable policies** (no universal acceptance formula): decisions record
  policy name+version. `paired-deterministic@1` = paired incumbent/candidate
  evidence, zero regressions on any split, strict visible improvement,
  held-out discipline. `provisional@1` = scoped, monitored, expiring
  activation for low-risk changes; confirmed to durable only if the window
  sustains baseline, else auto-revert (journaled intervention).
- **Model seam**: provider-neutral `ModelAdapter`, deterministic
  `FakeModelAdapter` in core, `MeteredJournalingAdapter` charging budgets and
  journaling full request/response for replay. No evolution component calls a
  model yet — that is deliberately the next phase.
- **CLI**: run / status / lineage / inspect / compare / replay / promote /
  rollback / resume / history, all with `--json` machine-readable envelopes;
  store failures exit 1 with clean diagnostics, never tracebacks.

## Verification evidence (commands + what they prove)

- `uv run pytest -q` → **77 passed**, offline, deterministic. Failure-injection
  coverage: schema mismatch rejected loudly (codec tests + runner protocol
  test); corrupt ledger/CAS handled cleanly (`test_persistence.py`,
  `test_cli.py::test_corrupt_ledger_yields_clean_error_envelope`); hanging /
  crashing / flooding candidates contained (`test_sandbox.py`); budgets
  enforced by trusted code (`test_budget.py`); holdout not exposed to
  proposers (`test_holdout.py`); activation survives restart and promotion is
  atomic under simulated crash (`test_persistence.py`); rollback preserves
  history; stall freeze + resume (`test_monitors.py`); provisional confirm and
  expiry-revert (`test_provisional.py`); phase-1 slice behavior intact
  (`test_slice.py`).
- `uv run mypy` → strict, no issues in 30 source files.
- `artifacts/demo/transcript.txt` → live CLI evidence: accepted evolution
  (0.455 → 1.000 across all splits), paired-gate refusal of a demotion,
  journaled rollback, evidence-gated re-promotion, and an exact replay match.

## Phase-3 decisions

- Promotion atomicity comes from journal design (one activation line appended
  last), not from locks or intent files; intent journaling (D13) is deferred
  until an operation needs more than one durable write.
- Torn-tail tolerance vs interior corruption: the crash artifact of an
  append-only journal is recoverable by construction; anything else is loud.
- The provisional confirmation criterion (`provisional@1`: every window cycle
  ≥ baseline) is deliberately the simplest defensible rule; uncertainty-aware
  comparison for stochastic behavior is specified but unimplemented (no
  stochastic surface exists yet).
- Candidate probes execute under a transient generation id
  (`candidate:<id>`); only retained generations get ledger ids, keeping the
  candidate/incumbent distinction visible in usage attribution.
- Network denial was NOT claimed: tests enforce env scrubbing and workspace
  privacy instead, and the docs state the gap (see below).

## Remaining security and evaluation limitations

- **The sandbox is fault containment, not a security boundary**: no network
  denial, no filesystem confinement beyond cwd/env hygiene, RLIMIT_AS
  unreliable on macOS. Adequate only while proposals come from the trusted
  registry (and next phase, from a model whose output is validated before
  durable promotion — but stage-3 kernel confinement should precede any
  third-party candidate source).
- **Evaluation is single-trial and deterministic-only**: no repeated-trial or
  uncertainty-aware policy exists yet; the policy registry is where it plugs
  in.
- **Inheritance-aware thresholds (D6 second half) are not implemented**: usage
  attribution now provides the data, but no policy consumes inherited-share
  yet.
- **Regression split is empty**: the mechanism exists, nothing grows it
  automatically yet.
- The stall detector watches score/generation flatness only; repeated
  *invalid-action* stalls will need runner-failure-kind tracking when tool
  use arrives.

## Mechanisms vs. still-untested policy hypotheses

**Mechanisms (implemented, tested):** codec strictness, append-only atomic
promotion, CAS verification, holdout isolation, budget enforcement, stall
freeze, provisional expiry/confirm, failure-as-data, usage attribution.

**Policy hypotheses (encoded but unproven at scale):** that
`paired-deterministic@1`'s specific bar (strict visible improvement + held-out
discipline + zero regressions) is the right durability gate (H1 remains open);
that `provisional@1`'s window rule catches regressions early enough; that the
stall window of 3 balances false freezes against long stalls. These are named
and versioned precisely so competing policies can be tested against them.

## Phase-3 next-phase note (historical)

*The stage-2b plan described here was carried out in phase 4 — see "Phase 4"
at the top of this document. Two items were deliberately deferred to stage 3:
automatic regression-split growth and aggregated per-proposer-model
acceptance statistics.*

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

## Hardening priorities (phase-2 work queue — COMPLETED in phase 3)

*All eight items below were implemented in phase 3; kept for the record with
their original rationale. See "Phase 3" above for what each became.*

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

## Phase-2 next-phase note (historical)

*The phase-2 recommendation ("proceed directly to Goal 3", i.e. execute the
hardening queue) was carried out in phase 3. The current next phase is the
model-backed self-evolution engine — see "Next phase — the model-backed
self-evolution engine (stage 2b)" near the top of this document and ROADMAP
stage 2b.*
