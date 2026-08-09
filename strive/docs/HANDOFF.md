# HANDOFF — strive

## Stage 3B.1 — derived integrity + revision shadow reads (current)

Hardened the derived side of the dual-write and proved shadow parity.
Generation-native records remain authoritative for every behavior.

1. **Prefix-pinned resumable operations.** `MigrationIntent@2` captures the
   exact canonical source prefix: complete-record count, whole-prefix hash,
   and a digest-sequence prefix hash (`SourceSnapshot.prefix_digest`).
   Resume verifies the prefix exactly — canonical records appended after
   intent creation are allowed; any altered prefix record refuses resume
   with a structured error. One operation-level mirror writer lock spans
   intent selection/creation, projection, and every state transition
   (`run_backfill_operation`); multiple unfinished intents refuse (repair
   the journal first); resume validates `migration_id` and `projector_ref`
   against the persisted intent.
2. **Fail-closed planning + full artifact closure.** `plan_projection`
   fails before publishing anything when existing mirrors are mismatched,
   duplicated, foreign, or carry unsupported projector refs. Parity
   verifies the complete closure per mirror: scope manifest, provenance,
   decision evidence, pinned descriptor, and canonical source artifact all
   exist, hash, decode, and agree. Missing *derived* objects are repairable
   from the pure plan; corrupt/mismatched objects fail closed and are never
   silently overwritten; a missing canonical source artifact is reported as
   data loss, not repaired around.
3. **Quarantine + rebuild.** `strive parity --rebuild` (`rebuild_mirror`)
   moves the corrupt mirror journal aside byte-for-byte (quarantine file,
   prior sha recorded), rebuilds mirrors and CAS closure purely from
   canonical history, validates fully, then atomically installs via
   `os.replace`. The canonical task ledger is never modified; the rebuild
   records intent, source prefix, outcome, and prior mirror hash.
4. **Prefix-scoped intent completion + schema-upgrade detection.** An open
   intent tolerates later canonical records and their live dual-write
   mirrors (e.g. a rollback or promotion before resume): the operation
   validates, repairs, and completes only its declared source prefix
   (`_entries_within_prefix`); newer records remain a subsequent
   operation's work and are never treated as foreign. A journal written in
   the exact stage-3B format (`migration-intent@1`) is detected precisely
   and directed to `strive parity --rebuild` (quarantine + rebuild from
   canonical history).
5. **Subject-specific revision shadow reads**
   ([shadow.py](../src/strive/shadow.py)). Each concrete generation-native
   read is paired at its point of use with the corresponding
   revision-derived read via `ShadowSession`: cycle baseline/candidate,
   compare left/right, replay baseline/candidate, promotion
   incumbent/target, rollback active/parent, audit target, and
   status/restart reads. The derived view (`build_shadow_view`) requires
   exact `SourceRecordRef` coverage in both directions, the supported
   projector, no duplicates, full artifact closure (manifests searched by
   `(kind, name)`, no positional delta assumptions), semantic
   revision/manifest/activation validation, and bounded cycle-free lineage
   traversal. Derived corruption or unexpected exceptions return
   *unavailable with a reason* — they never raise into (or hang) a
   committed canonical operation, and no active revision is reported while
   unavailable. A mismatch is recorded, never substituted.
6. **Execution provenance.** Before each artifact execution the session
   CAS-stores a per-subject `ResolvedHarnessManifest` whose contribution
   names the baseline (shadow-active) revision at a **tamper-evident
   journal head** (complete-record count + digest-sequence prefix hash,
   not a bare count) and whose effective binding names the executed
   artifact — so a run that activates a candidate still identifies the
   baseline revision that produced its evaluation. Separate refs per
   subject (baseline, candidate, compare-left/right, replay subjects).
7. **Shadow coverage + cutover gate.** Every attempted check is durably
   recorded — agreed, diverged, unavailable, or not-applicable — in a
   derived coverage journal (`ledger/<task>.shadow.jsonl`) plus a run
   event; identical divergence incidents are deduplicated in the canonical
   ledger. `strive shadow` reports eligible/checked/unavailable reads and
   the divergence rate; `cutover_eligibility` demands complete parity,
   zero divergences, AND the declared minimum coverage
   (`MIN_CUTOVER_COVERAGE = 0.9`) — the mere absence of divergence records
   is explicitly insufficient.
8. **Failure injection + differential controls** (test_shadow.py, 25
   tests): altered prefix, appended records, double intents, wrong
   migration/projector on resume, plan-fails-before-publish, missing vs
   corrupt derived objects, corrupt decision evidence, missing source
   artifact, quarantine+rebuild round-trip, open-intent-then-rollback
   resume, stage-3B journal upgrade, agreed checks at every use site,
   restart reads, shadow-materialized source evaluating identically,
   unavailable ≠ divergent, mirror-journal-as-directory never failing a
   cycle, lineage-cycle detection, divergence durability + deduplication,
   per-subject execution manifests, coverage-gated cutover, and
   mirror-off / mirror-on / shadowed runs yielding identical canonical
   results.

**Verification:** 207 tests pass; `mypy --strict` clean over 44 files.
Live CLI smoke: run → `status`/`lineage` → `strive shadow` shows 4/4
agreed checks, cutover ELIGIBLE → a stage-3B `migration-intent@1` line
appended → `revisions` reports the precise unsupported-schema error naming
`parity --rebuild` → rebuild quarantines and recovers → `shadow` eligible
again.

**The Stage 3B.1 claim, stated precisely:** strive shadows each concrete
generation-native read with the corresponding revision-derived read at the
point of use, records exact execution manifests and coverage, and remains
safe under derived corruption. Revisions still do not control behavior.

**Next phase (exact):** a narrowly reversible revision-read cutover with a
kill switch (gated on `cutover_eligibility`); the prompt-surface composite
evolution experiment follows separately.

## Stage 3B — crash-consistency correction (final pre-merge)

The dual-write was reworked before merge around an explicit crash model:
1. **Canonical vs derived, physically separated.** The task ledger holds
   only generation-native records; mirrors live in `<task>.mirror.jsonl`.
   A corrupt mirror journal cannot block run, activation, rollback, replay,
   or inspection (tested); parity reports the corruption cleanly.
2. **Source refs, never positions.** Every mirror carries a deterministic
   `SourceRecordRef` (source schema, journal identity, complete-record
   ordinal, canonical digest). A missing mirror in the *middle* of history
   is found and filled by ref while later mirrors stay matched; the derived
   active revision follows source activation order even when a repaired
   mirror is appended last.
3. **Durable operations.** Backfill/repair persist `MigrationIntent`
   (op id, migration id, source head/hash, projector ref) before any work,
   `MigrationProgress` checkpoints, and `MigrationCompleted` only after
   parity validation over the intent's declared history. Pending status is
   completion-based: crash-after-parity-but-before-completion stays pending
   and resumes the SAME intent (source head/hash preserved across retries).
   Every crash point is tested.
4. **Plan/apply split.** `ProjectionPlan` is pure (mirror records + CAS
   payload texts/hashes via `hash_text`, publishing nothing); application
   re-reads the source head under the mirror writer lock and refuses stale
   plans; `parity` and migration discovery are read-only (tested: no CAS or
   journal writes). A source commit whose live mirror publication fails
   yields the explicit `source-committed-parity-incomplete` diagnostic —
   the operation is committed, its mirror is repairable.
5. **Operation-specific evidence.** Legacy `activation@2` maps to
   `decision_ref=None`; the generation's original decision lives only in
   `MigrationProvenance` (which now also preserves `Generation.surface`).
   Explicit evidence on a future revision-native activation is representable
   and tested as distinct from the generation's original decision.
6. **Fail-closed projector.** Pinned `generation-to-revision@1` with the
   explicit historical descriptor `strategy-code@1` (never current
   pointers); pre-work source validation (unique ids, parent-precedes-child
   acyclic lineage, activations target existing generations, task identity,
   supported surfaces, injective id mapping) with structured errors;
   unsupported projector refs are flagged and repair refuses.
7. **Permanent control.** Mirror-enabled vs mirror-disabled runs produce
   identical generation-native records, cycle results, active generation,
   and replay (tested).

## Stage 3B — dual-write revision storage (what was implemented)

The exact narrow slice ROADMAP fixed, nothing more:
- **`revisions.py`** — the frozen core wire types moved verbatim from the
  spike to their permanent home (same kinds/versions); `stage3_contracts.py`
  keeps only the provisional contracts and re-exports the core so the spike
  tests validate it unchanged.
- **`dualwrite.py`** — deterministic, field-preserving mirrors: every
  retained `generation@2` gets a `revision@1` (canonical single-binding
  task-scope manifest; task fingerprint/origin/weakness/decision@1 evidence
  preserved via a CAS `MigrationProvenance` referenced from
  `provenance_ref`; the delta's before-binding is the parent's content ref)
  and every `activation@2` gets a `revision-activation@1` (mode, reason,
  timestamp, expiry/monitoring data verbatim; legacy policy markers →
  `name@0`). Mirrors are appended after their source records — explicitly
  NOT one atomic transaction; the generation ledger stays the source of
  truth. `parity_status` recomputes mirrors (determinism makes this exact)
  and `repair_parity` reconstructs missing ones without duplicates,
  refusing ambiguous history (`ParityError`) rather than papering over it.
- **`migrations.py`** — the sequential registry: `0001-legacy-unscoped-
  ledger` (wraps the proven phase-4.6 migration) and `0002-revision-
  backfill` (append-only; preserves the source journal byte-for-byte as a
  prefix; journals a `revision-backfill` marker with the pre-backfill
  sha256; validates output; no-ops when parity is already complete; refuses
  corrupt history loudly). `strive migrate` applies pending entries in
  order — a legacy root chains 0001 then 0002 in one pass.
- **CLI additions only** (`parity [--repair]`, `revisions`, `migrate`);
  every existing command is unchanged. `history` renders the mirror kinds.
- Store accepts the two new ledger-entry kinds with read-time task-isolation
  checks on their scopes; the loop, activation, cycles, and
  execution-and-decision replay remain generation-native.

**Verification** (`uv run pytest` → 182, mypy strict clean, 42 files;
see the crash-consistency section above for the failure-injection matrix):
exact generation/revision and activation/mirror field mapping; accepted AND
rejected decision evidence recovered from CAS provenance; active
generation/revision parity at every activation-history prefix; rollback and
provisional metadata equivalence (incl. `seed@0` legacy-policy mapping);
backfill idempotence and corrupt/ambiguous-history refusal; partial
dual-write detected and repaired (also demonstrated live via
`strive parity --repair`); historical descriptor validity (prompt@1 under
prompt@2, spike tests); scope/mask/parent/manifest and cross-task isolation
invariants; all Stage 1–2b tests and replay behavior green (one entry-count
assertion updated for the extra mirror line; semantics unchanged).

**The Stage 3B claim, stated precisely:** strive mirrors generation-native
history into field-preserving composite revision records and can backfill,
inspect, verify, and repair revision parity. Revision-native execution,
selection, activation, and replay remain future work.

**Next slice options** (historical — Stage 3B.1 took option (a), the
parity slice, and delivered its verified dual-read comparison as shadow
reads; the cutover to revision-native reads is the next phase above).

State as of 2026-08-08, after six phases plus correction passes: the vertical
slice (stage 1), the research-and-redesign phase (notes 01–06,
[comparative matrix](agents/research/comparative-matrix.md),
[ARCHITECTURE](ARCHITECTURE.md), [ROADMAP](ROADMAP.md)), the phase-3 hardening
of the core harness (stage 2a), the phase-4 model-backed offline
self-evolution loop (stage 2b), the phase-4.5/4.6 correctness passes over
stage 2b, the stage-3A contract design with its revision pass, and the
stage-3B dual-write with its 3B.1 integrity/shadow-read hardening.

## Stage 3A — contract design (what was decided)

Six accepted ADRs under [adrs/](adrs/README.md) settle Stage 3's contracts
design-first; experimental spikes (`stage3_contracts.py` + 25 round-trip/
structural tests) prove the shapes serialize and enforce their rules. The
live loop is untouched; the new codec kinds are additive and unused.

**Key decisions** (rejected alternatives recorded in each ADR; wire schemas
went provisional during a revision pass, were re-validated by spike tests,
and are now frozen for 3B):
- Revisions replace one-generation-one-file; identity is
  `RevisionRef(scope, id)` with `base_parent` distinct from
  `provenance_parents` and optional proposal/provenance CAS pointers.
  Deltas are complete binding transitions (`absent | masked |
  content(ref, descriptor_ref)` before→after; labels derived) so exact
  inversion, unmasking, and conflict checks are representable. A revision
  owns its `ScopeManifest` (own-scope bindings incl. masks, canonical
  order enforced); runs/evaluations reference a `ResolvedHarnessManifest`
  (effective bindings + contributing revision refs/journal heads) — and
  **never** an evaluation manifest, which ValidationBundles own (one
  revision under two manifests is tested). Rollback is a new revision
  rather than partial activations.
- Scopes are typed (`ScopeRef` + explicit `ResolutionContext`; no colon
  parsing, no implicit default project); `delete` (remove own override,
  inheritance resumes) is distinct from `mask` (tombstone stopping
  fall-through). Provisional is an activation mode, not a scope.
- Risk is computed by the descriptor's risk policy from artifact name +
  scope + transition label — a delta carries nothing to trust, content
  bindings pin their `descriptor_ref`, and policy parameters are tiered by
  family (budget/sandbox knobs rank high), not uniformly low-risk.
- Task specs are environment-generic (adapter + schemas + scorer + config
  ref; `solve(str)->int` lives in the FunctionTask config blob); dataset
  revisions are reconstructable via per-split CAS manifests; regression
  growth is a `DatasetRevision` bump plus forced incumbent re-baseline,
  never task-drift acknowledgement. The environment base protocol does not
  assume reset — Resettable/Checkpointable/Forkable are capabilities.
- Selection decisions are policy-neutral: `policy_ref` + a closed kernel
  disposition vocabulary {promote, reject, frontier_add,
  provisional_activate}, each requiring evidence, each pinning its
  objective spec (rejected: per-policy ledger fields — endless version
  churn).
- Algorithms get a narrow `KernelServices` handle under a trusted budget —
  stated honestly as an API contract for trusted L1 plugins, not
  hostile-plugin isolation; search state is journaled
  (`AlgorithmRun`/`AlgorithmStep`) so a crashed search resumes from the
  journal (rejected: loop subclassing; in-memory populations).
- JSONL journals stay authoritative; `append_batch` commits by framing
  (batch id + commit marker, torn batches ignored like torn lines), and the
  commit ordering rule keeps candidate revision/evidence/decision durable
  *before* activation is attempted — revision+activation is explicitly NOT
  the canonical atomic batch, so a lost activation head-race orphans
  nothing; indexes are disposable caches with index-through-head semantics;
  schema changes go through a sequential migration registry (rejected:
  SQLite as the journal; migration-on-read).

**Compatibility plan**: today's `generation@2` ≙ one-delta revision with
`before_ref` = the parent's *content* ref and a versioned
`ledger-migration@1` proposer (`revision_from_generation`, tested against
live-loop output and refusing inconsistent parents); existing policies keep
their names/versions; the phase-4.6 legacy migration becomes
migration-registry entry 0001 and the generation→revision rewrite entry
0002 (Stage 3B); `FunctionTask` adapts `solve(str)->int` unchanged.

**Freeze scope**: only the core wire types are frozen for 3B (ScopeRef,
RevisionRef, BindingState, SurfaceDelta, ManifestBinding, ScopeManifest,
JournalHeadRef, ScopeContribution, ResolvedHarnessManifest, HarnessRevision,
RevisionActivation, MigrationProvenance + the historical descriptor
registry shape). The lifecycle seam is complete: RevisionActivation@1 maps
activation@2 field-exactly (legacy policy markers → the reserved name@0
era; rollback history and last-activation-wins derivation verified against
a real journal), MigrationProvenance preserves task fingerprint, origin,
weakness, and CAS-encoded decision evidence, and descriptor pinning is
historical (a prompt@1 binding stays valid after prompt@2 becomes current;
risk derives from the delta itself, param families fail closed, trusted
settings are not evolvable);
task/dataset/evaluation, selection/frontier, algorithm-state, and backend
schemas remain provisional until their slices, with the unresolved needs
recorded in adrs/README (typed object refs, typed evidence roles,
policy-detail refs, frontier removals/snapshots, objective+RNG+state refs
for bit-reproducible resumption).

**Risks carried into 3B**: the generation→revision migration touches every
task ledger (mitigated by the registry's detect-loudly/preserve-original/
validate-output rules, all inherited from the proven legacy migration);
scope journals add a second writer surface (single-writer-per-journal
stands); the wire schemas are now frozen for 3B after the revision pass —
any further shape change in 3B costs a version bump plus a migration-registry
entry, deliberately.

**Exact next slice (independently mergeable)**: **dual-write revision
storage + the SurfaceDescriptor registry** — implement the frozen core wire
types, ship migration-registry entries 0001/0002 (the 0002 backfill is
field-exact with MigrationProvenance + CAS decision evidence), and write
revision@1/revision-activation@1 alongside the generation-native records
the loop keeps producing. Loop/activation/replay stay generation-native
until a later parity slice; Pareto search, prompt/policy proposers, and
scope journals come after, each as its own slice (ROADMAP stages 3B/3C).

## The Stage 2b claim, stated precisely

> Strive can accept model-path proposals, validate and classify them, execute
> candidates outside the kernel process, compare them with an incumbent,
> retain decisions and lineage, and replay execution and selection. The
> deterministic fixture proves pipeline correctness; real-model proposal
> quality remains an untested capability question.

## Phase 4.6 — final pre-merge corrections (completed fixes)

A second, final precision pass before merging PR #39; 133 tests, strict mypy.

1. **Legacy ledger handling.** A stage-2a `ledger/ledger.jsonl` is now
   detected loudly at store construction with the exact migration command;
   `strive migrate-legacy` converts it to the task-scoped v2 ledger while
   preserving generations, decisions, every activation in order (rollbacks
   included), cycles, and the original file byte-for-byte, and journals a
   migration marker. Mixed/foreign-task legacy history is refused (legacy
   generations carry no task identity of their own). Tested against a real
   v1 fixture built by downgrading current records (v1 = v2 minus task
   fields, by construction).
2. **Task binding everywhere.** One shared `guard_task_binding` runs in
   run/audit/compare/promote/replay/seed; reading a task ledger rejects any
   generation/activation/cycle whose task id conflicts; task-fingerprint
   drift refuses mutation unless `--acknowledge-task-drift` (journaled as an
   intervention); read-only operations proceed and report drift.
3. **Budget semantics made exact** (see phase 4.5 item 3, now corrected in
   place): output-token requests capped to remaining allowance; post-call
   token overruns charged, journaled, and their completions rejected; cost
   enforced only against `reports_cost` adapters (fail-closed
   `cost-limit-unavailable` otherwise — the OpenAI-compatible adapter does
   not report cost); per-limit semantics journaled with every cycle.
4. **Trust-boundary claims corrected**: no more "no write path" / "physically
   out of reach" — candidates are process-separated and never imported into
   the kernel, and until Landlock/seccomp/containers exist, malicious code
   can access anything available to the controller's OS user. Real-model
   execution stays behind `--unsafe-model-code`.
5. **Proposal evidence validation**: with visible failures present,
   `trace_evidence` must be nonempty and entirely within the visible
   failing-case ids (empty / unknown / valid all tested).
6. **Post-call cost overrun** (final): with `reports_cost` adapters, a call
   that crosses the cost ceiling is charged, journaled
   (`model_call_overrun`), and its completion rejected before it can become
   a proposal; reaching the limit exactly succeeds and the next call is
   denied pre-call; fail-closed behavior for non-reporting adapters stands.
7. **Centralized drift acknowledgement** (final): `guard_mutation` is the one
   entry point for mutating operations — binding + drift validation + durable
   `task-drift-acknowledged` journaling (written only when drift actually
   exists). `run` and `promote` both use it; future mutations cannot forget.
8. Low-cost cleanups: stale test names no longer imply model reasoning or
   full replay; decision replay resolves the recorded policy by name AND
   version (refusing on mismatch) and compares verdict + both scores +
   regressed ids; the metered wrapper contains *any* ordinary adapter
   exception as journaled `model-error` while KeyboardInterrupt/SystemExit
   propagate; the audit split is documented as operationally separate, not
   secret; historical handoff text updated (superseded v1 golden, replay
   naming).

## Phase 4.5 — stage-2b correction pass (completed fixes)

A focused correctness pass before merging stage 2b; 115 tests, strict mypy.

1. **Task-scoped state.** Stores are bound to a task (per-task ledger files);
   generations carry `task_id` + `task_fingerprint`, activations carry
   `task_id` (schema bumps to `generation@2`/`activation@2`; superseded v1
   records are rejected loudly — migration tooling is deliberately deferred).
   Cross-task tests run two tasks against one artifact root with zero
   contamination; the loop refuses a store bound to a different task.
2. **Fixture leak removed.** The `max-integers` seed source no longer explains
   its own bug (seed sources are proposer-visible evidence); the fake is
   renamed and documented as a *scripted proposal fixture*
   (`scripted_fixture_adapter`), and no doc claims it derived the repair from
   evidence or demonstrated model reasoning.
3. **Budget truthfulness.** Uniform limit semantics defined and tested:
   0 = nothing allowed, -1 = accounting only. Exact token semantics: requested
   output tokens are capped to the remaining allowance and accumulated usage
   gates the next call, but one call's *input* tokens can overshoot — such an
   overrun is charged, journaled (`model_call_overrun`), and its completion is
   rejected before it can produce a proposal. Cost is enforced only against
   adapters that declare trustworthy cost reporting (`reports_cost`); the
   metered wrapper fails closed otherwise — and the OpenAI-compatible adapter
   does NOT report cost, so no cost enforcement is claimed for it. Cumulative
   output bytes are hard-enforced (per-execution caps equal the remaining
   allowance); HTTP timeouts are capped by remaining wall time; wall time
   gates model calls as well as executions. Per-limit semantics
   (enforced / accounting-only / adapter-dependent) are journaled with every
   cycle. Every enforced limit has a test.
4. **Replay precision.** The feature is now named what it is:
   **execution-and-decision replay** (baseline + candidate re-execution and
   recorded-policy decision check). Full-cycle replay (diagnosis, prompt
   reconstruction, recorded completion injection, proposal parsing, screening)
   is explicitly deferred.
5. **Evaluation discipline.** Splits now separate visible (train),
   held-out/regression/adversarial (development/selection, used by every
   promotion decision), and a new **audit** split — a final holdout excluded
   from routine cycles entirely and queried only via `strive audit`.
   Proposer-facing history now reports visible-split score movement only
   (overall/hidden-influenced scores no longer flow back).
6. **Provisional safety.** Provisional activation of executable
   `strategy-code` is refused (tested); the expiry/confirmation mechanics stay
   tested at the store level for future explicitly low-risk non-code surfaces.
7. **Real-model safety.** A configured real provider requires the explicit
   `--unsafe-model-code` acknowledgement (the subprocess lacks
   network/filesystem confinement; the AST screen is a prefilter, not a
   security boundary). The scripted fixture remains the safe default; missing
   or invalid env configuration is a clean `ModelConfigError`.
8. **Claims corrected** across README/ARCHITECTURE/ROADMAP/HANDOFF and the PR
   summary; demos regenerated under the corrected semantics (including audit
   runs and cross-task runs against one root).

Low-cost items also done: normalized model finish reasons drive truncation
classification; proposal `trace_evidence` must cite visible failing case ids;
`model_call` events carry compact metadata + CAS refs instead of duplicated
contents; the syntax-error test fixture is now an actual syntax error ("this
is not python" parses as `this is (not python)`); mutating store operations
take an advisory writer lock, generation-id allocation happens under it, and
activations support an `expected_active` head check (used by the loop and by
promotion).

**Deliberately deferred (explicit limits carried to stage 3+):** schema
migration tooling for superseded record versions; full-cycle replay;
concurrent multi-host writer support (single-writer per task remains the
model); typed event payloads; CAS power-loss durability (objects are not
fsynced); automatic regression-split growth; per-proposer-model acceptance
statistics; Pareto populations; Landlock/seccomp. Candidate code still
receives hidden case *inputs* at execution time (never expected outputs) —
documented in README; real fix is stronger sandboxing.

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
  evidence; the model *pipeline* carries a repair through schema validation,
  screening, sandboxed validation, and the paired gate (0.500 → 1.000, zero
  regressions). In CI/demos that repair comes from a scripted proposal
  fixture authored by us — see phase 4.5: this proves the pipeline, not model
  reasoning.
- **Real adapter, env-only.** `STRIVE_MODEL_PROVIDER=openai-compatible` +
  `STRIVE_MODEL_BASE_URL`/`STRIVE_MODEL_API_KEY`/`STRIVE_MODEL_ID` builds a
  stdlib-only adapter. Nothing in tests or default commands touches it.
- **CLI.** `strive run --proposer {registry,model}` (model uses the offline
  fake unless env-configured); `strive inspect --run ID --type model_call`
  filters journaled model/proposal events; `--json` everywhere.

## Phase-4 verification evidence

- `uv run pytest -q` → **91 passed** at phase 4 (now **115** after phase
  4.5), offline. The demonstration matrix:
  scripted-fixture fix of the non-planted weakness promoted through
  `paired-deterministic@1` on protected splits; registry control cannot fix
  it; execution-and-decision replay reproduces the decision; malformed / truncated /
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
- The scripted fixture responder parses the prompt (parent id, cited cases)
  rather than being keyed to exact prompt bytes — prompt evolution doesn't
  silently break the fixtures, and the fixture's role as an authored stand-in
  (not model reasoning) is explicit in `fakemodel.py` and README.
- `EvidenceDiagnoser` names no weakness (`visible-case-failures`) — the
  CH lesson about confidently-wrong self-diagnosis argues for packaging
  evidence over guessing causes when no signature matches.

## Model-dependence limitations (stated plainly)

- **The CI "model" is a scripted proposal fixture.** Every green test proves
  pipeline correctness — validation, gating, journaling, execution-and-decision
  replay — and nothing about real-model proposal quality or reasoning. The one honest capability claim: the
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
  rejected loudly; a golden record at the *current* versions is pinned by test
  so shape changes force version bumps (the original v1 golden was superseded
  by the task-scoping bump; a companion test pins that v1 now fails loudly).
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
