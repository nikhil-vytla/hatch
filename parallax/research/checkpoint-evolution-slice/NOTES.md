# NOTES — checkpoint-evolution executable slice

Goal: implement checkpoint evolution (the SlopCodeBench-derived synthesis
method designed in `../slopcodebench-method/` and specified in
`../../docs/methods/checkpoint-evolution.md`) as an offline-verifiable
vertical slice, following the Evolving Intent slice's conventions: strict
frozen Pydantic models, discriminated unions, evidence receipts,
deterministic replay, no paid inference in this unit.

## Work log

- Branched `parallax-checkpoint-evolution` from `origin/main` at `5fae166`
  (Gate SWE-bench screening on verifier safety, #20). The concurrent
  worktree `hatch-parallax-ei` and PR #25 are untouched.
- Read the authoritative design inputs: the four research docs in
  `parallax/research/slopcodebench-method/`, the draft method doc, the EI
  implementation (`types.py`, `evolving_intent.py`, `gsm8k.py`,
  `runner.py`, `report.py`, `outcome.py`, `canonical.py`, `swebench.py`),
  `RESEARCH-PROCESS.md`, and the decision records.
- Checked `parallax/research/admission-qc/`: **not on main** — it lives on
  the open PR #22 branch (`parallax/admission-qc`). Per instruction
  ("reuse/adapt existing gate machinery … if present on main"), the gate
  *specifications* from that branch were read and adapted conceptually
  (gold/no-op bidirectional pair, per-source recorded rejection, retry
  only on infra faults, code/skill split), but no code from that branch is
  imported or depended on.
- Checked upstream semantics against the research trail's pinned
  characterization (paper arXiv:2603.24755 §2.2–2.4, repo
  `SprocketLab/slop-code-bench@8e3a8b6` `docs/contributing-problems/`,
  `docs/evaluation/architecture.md`, as recorded in
  `../slopcodebench-method/algorithmic-model.md` §1). The upstream
  mechanics the slice must reproduce faithfully:
  - a problem is an ordered checkpoint list, n ∈ [3,8]; at stage i the
    agent sees only spec S_i and its own prior workspace y_{i-1}; y_0 is
    empty; only the working directory persists;
  - sealed obligations accumulate: Ω_i = Ω_{i-1} ∪ T_i; prior-stage tests
    are re-classified as regression automatically regardless of markers;
    C_1 has no regression tests;
  - three verdicts per stage: strict (all Ω_i), ISO (all T_i), core
    (core-marked subset of T_i);
  - black-box, entrypoint-only evaluation with pinned normalization;
  - test failures are Verification outcomes; infrastructure faults are
    RunFailures; a failing verdict never halts the family, a missing
    workspace censors the remaining stages (recorded, not dropped).

## Design decisions

### Module layout

Mirrors the EI split: `checkpoint_evolution.py` owns the domain model,
the entrypoint verifier, and admission; `checkpoint_runner.py` owns
episode stepping, arms, receipts, and evidence JSONL. No new shared
abstraction; `canonical.py`, `outcome.py`, `types.py` are reused as-is.

### Task family instantiation (deliverable 2 justification)

Options considered:

1. **Synthesize checkpointed variants from an ingested source** (GSM8K or
   the SWE-bench slice). Rejected: GSM8K has no workspace or entrypoint
   contract, so a "checkpointed GSM8K" would not exercise the persistent
   file-tree state, subprocess verification, or regression obligations
   that are the whole point of the method — it would be a shortcut
   scaffold. SWE-bench repositories have workspaces but building a
   3-checkpoint decomposition of a Django instance offline would mean
   inventing sealed suites we cannot validate without containers and paid
   agent calls, and the synthesis-workflow doc (S1–S6) says agent-drafted
   families need gates G3/G4/G6 (mutants, churn ratio, headroom) that are
   compute-priced — out of scope for a no-inference unit.
2. **Small hand-verified seed family** (chosen). One hand-authored CLI
   tool family, `tally`, 3 checkpoints, in the upstream problem shape:
   spec prose with examples and pinned normalization, sealed
   argv/stdin/stdout/exit cases executed black-box through the declared
   entrypoint. Hand-authoring is exactly what upstream did for all 36
   problems (paper §2.2: "All of our problems are written by hand"), so a
   hand-verified seed is the *faithful* minimal instantiation, not a
   shortcut. The synthesis pipeline (S1–S6) remains future work; this
   family is the fixture that proves the harness end to end.

Family shape (operators from the closed set in algorithmic-model §2.4):

- C1 `core`: `tally.py total` — sum `<name> <count>` records from stdin;
  malformed record → exit 2, message to stderr, nothing on stdout.
- C2 `extension`: new subcommand `top` — name with the largest
  aggregated total, ties broken by lexicographically smallest name
  (normalization pinned in the spec); `total` behavior untouched.
- C3 `input-source`: optional `--input FILE` before the subcommand reads
  records from a file; missing file → exit 3; the stdin channel is
  preserved and re-pinned by a new sealed case.

Design pressure exists but is mild by construction: a C1 solution that
keeps only a running sum must restructure to per-name aggregation at C2,
and a hardcoded-stdin reader must abstract its input source at C3. No
churn-ratio measurement (G4) is claimed — that gate is explicitly
deferred, consistent with the workflow doc's "automatable, given the
naive build" caveat.

### Upstream fidelity choices and declared divergences

- **Workspace**: a validated file tree (relative paths, no traversal,
  text content). The dependency manifest d_i from the model's
  W_i = (y_i, d_i) is not separately modeled: for a single-file Python
  track with no installs, the manifest is empty by construction. Recorded
  as a slice restriction, not a semantic change.
- **Entrypoint contract**: upstream specs use `%%%ENTRYPOINT%%%`
  placeholders; the slice pins a Python track (`interpreter: "python3"`,
  resolved to `sys.executable` at execution) plus a declared entry file.
  Language-agnostic contracts return when a second track is needed.
- **Verification**: one fresh workspace materialization per sealed case
  (upstream runs a pytest suite in one container per checkpoint; the
  per-case fresh copy is stricter about inter-case independence and is
  declared as a divergence). Comparison is exact bytes on stdout plus
  exit-code equality; error cases assert non-empty stderr without pinning
  strings (upstream review-checklist rule). `PYTHONHASHSEED=0` and a
  minimal environment pin execution determinism.
- **Timeouts**: a per-case timeout is a *case failure* (behavioral),
  matching upstream where a hanging solution fails its tests; failure to
  spawn the interpreter is a verifier RunFailure (infrastructure).
- **Budget**: declared per stage as `max_output_bytes` on the returned
  workspace. Upstream's wall-clock budget grades whatever partial
  workspace exists at exhaustion; a synchronous workspace-in/workspace-out
  agent boundary has no partial state, so an oversized return is
  classified as a budget RunFailure (no workspace produced). Declared
  interpretation, recorded in the method doc.
- **Regression reclassification** is automatic and unconditional
  (`include_prior_tests: false` has no representation — dropping
  obligations would be a declared verifier intervention and is simply not
  constructible in this slice).
- **Arms**: `evolved` and `carry-reference` (the recommended first
  contrast, method doc TODO). `monolithic`, `foresight`,
  `repair-scheduled` are not implemented.
- **References**: a single incremental reference build, not the dual
  independent references of workflow stage S4. Dual references exist to
  catch spec ambiguity in *generated* families; for a hand-verified seed
  the single reference plus sealed-case review carries admission, and the
  dual-reference regimen is deferred to the synthesis pipeline.

### Delivery invariant (deliverable 3)

Adapted from the upstream-design-audit finding (PR #21): turn delivery
must be harness-owned and unskippable. Here checkpoint delivery is owned
by the runner loop — the agent is a pure function of
(public spec, carried workspace, budget) and has no advance channel — and
`FamilyRun` model validators make a graded episode with missing, skipped,
reordered, or spec-drifted checkpoint delivery unrepresentable:
receipt indices must be exactly 1..k, each receipt's spec digest must
equal the family's checkpoint spec digest, the workspace digest chain
must be exact (evolved: agent's own terminal workspace; carry-reference:
the frozen reference), and censored stages must be exactly k+1..n with a
RunFailure at stage k.

### Admission gates (deliverable 4)

Executable, recorded, bidirectional — adapted from the PR #22
specifications and the six-gate design in
`../slopcodebench-method/synthesis-workflow.md` §2:

| Slice gate | Workflow analog | Predicate |
|---|---|---|
| schema-roundtrip | (evidence discipline) | canonical bytes → model → identical digest, family and references |
| completeness | G6-shape / S2 rules | references aligned to family, digest binding, per-stage core case present |
| leakage | G5 (lint half) | no sealed case id or serialized sealed case in any public spec; deliveries are typed public-only |
| gold-incremental | G1 | reference workspace at stage i passes strict Ω_i, for every i |
| no-op | G2 | stage-(i−1) reference workspace fails isolated T_i, for every i (W_0 = empty) |

Deferred, recorded as such: G3 mutant/ambiguity (needs dual references),
G4 churn ratio (needs the naive build), G6 headroom (compute-priced),
and the judgment-side review skill (PR #22 ships it; not on main).

## Implementation log

- Wrote `checkpoint_evolution.py` (domain + verifier + admission) and
  `checkpoint_runner.py` (delivery loop, arms, receipts, manifest,
  evidence JSONL) with strict frozen models and discriminated unions.
- Generated `tests/fixtures/checkpoint_family.json` with
  `make_seed_family.py` (this folder) — deterministic canonical JSON;
  regenerate with `python3 make_seed_family.py` from this directory.
- Test suite: `test_checkpoint_evolution.py` (domain validators, verifier
  semantics, verdict vector, admission gates both directions) and
  `test_checkpoint_runner.py` (both arms end to end with scripted agents,
  continue-on-failure, censoring, budget faults, delivery-invariant
  unrepresentability, evidence byte-stability and replay).
- Mutation gauntlet: `mutants/run_gauntlet.py` (this folder) applies 14
  targeted mutants to the two new modules and requires the offline suite
  to fail for each; see gauntlet results below.
- First full test run: 32/33 new tests passed; the one failure was a test
  bug, not a code bug — with the reference-mimicking agent on
  carry-reference, the stage-2 *output* digest equals the frozen
  reference digest, so swapping it into the stage-3 input was a no-op.
  Switched that test to the myopic agent, whose outputs differ from the
  references.
- The seed family admitted on its first generation run: all five gates
  passed without reference or case adjustments.

## Verification gate results

- `uv run python -m pytest -q` — 153 passed (120 pre-existing + 33 new).
- `uv run python -O -m pytest -q` — 153 passed; only the expected
  warning that `-O` disables test assertions (source invariants are
  exceptions and model validation).
- `uv run ruff check src tests research/checkpoint-evolution-slice` and
  `ruff format --check` — clean.
- `uvx ty check src` — clean.
- `uv run python -m compileall -q src` — clean.
- `uv build` — sdist and wheel built.
- Mutation gauntlet — 14/14 killed:
  M01 regression obligations dropped; M02 strict ignores regression;
  M03 all cases labeled new; M04 no-op gate inverted; M05 gold accepts
  isolated; M06 leakage gate blind; M07 exit codes not compared;
  M08 timeout reclassified as infrastructure; M09 first checkpoint
  skipped; M10 workspace not carried; M11 missing workspace does not
  censor; M12 carry-reference collapses into evolved; M13 manifest
  digest unbound; M14 spec-drift check disabled. The gauntlet re-runs
  the baseline after restoration to prove the tree is clean.

## Screening prerequisites (second unit, still no paid inference)

The preregistration named two blockers before the first paid call: a
provider adapter on the `CheckpointAgent` boundary and container
sandboxing for the verifier. Both are now implemented, plus an offline
dry-run mode that proves the whole screening path.

### Main-merge interlude

PR #26 (`parallax-docs-math`) rewrote the LaTeX delimiters in
`docs/methods/checkpoint-evolution.md` on main while this branch had
rewritten the same file. Merged `origin/main` into the branch (merge,
not rebase), kept the as-implemented content, converted the surviving
`\( \)` delimiters to the GitHub-renderable `$...$` / ```math syntax
PR #26 established, and verified no old delimiters remain in any
markdown this branch touches. PR #27 reports `MERGEABLE`/`CLEAN`.

### Provider adapter (`src/parallax/checkpoint_agent.py`)

- `ProviderCheckpointAgent` maps the existing OpenAI-compatible provider
  boundary (`provider.py`, HUD gateway; the `tool_calls: null` wire fix
  and truncation handling already live there) onto `CheckpointAgent`.
  The agent stays a pure function of the delivered stage: rendering
  depends only on (public spec, carried workspace, declared budgets)
  plus frozen construction arguments, and rendering has no access to
  sealed material *by construction* — `render_stage_messages` takes only
  the contract and the public `CheckpointDelivery`.
- Reply protocol: one JSON object `{"files": {path: content}}`; the
  carried workspace is serialized to the agent in the same shape.
  An exact ```json fence is unwrapped (the wire variation Haiku produced
  in the SWE-bench screening); anything else malformed is an
  `AgentReplyError` → agent RunFailure under the runner's existing
  classification. `finish_reason: "length"` raises `BudgetError` →
  budget RunFailure.
- Metering: `StageUsage` (prompt/completion tokens, conservative USD at
  Haiku gateway rates 1.0/5.0 per million) rides back on a
  `MeteredWorkspace`, or on the raised error's `stage_usage` when the
  reply is rejected *after* spend, so failed stages still meter. The
  runner records it as `StageReceipt.usage` (optional field; scripted
  offline agents leave it null, so existing evidence still validates).
- A gateway reply without a usage block is rejected as unmeterable
  (agent fault) rather than silently unmetered.

### Container sandboxing (`src/parallax/checkpoint_sandbox.py`)

- `SandboxCaseExecution` runs every sealed case in a disposable
  container: image pinned by immutable digest
  (`python@sha256:57cd7c…710de`, resolved from `python:3.12-slim` for
  `linux/amd64` per the repo's SWE-bench Docker discipline — explicit
  `--platform=linux/amd64` on an arm64 daemon), `--network=none`,
  `--read-only` rootfs with only the materialized working directory
  writable, `--pull=never`, non-root `--user=1000:1000`,
  `--cap-drop=ALL`, `no-new-privileges`, 1 CPU, 512 MB memory (swap
  disabled), 128-pid limit, 16 MB `/tmp` tmpfs.
- Timeout split preserves the black-box contract: the *case* deadline is
  enforced inside the container by coreutils `timeout` (exit 124 →
  `"timeout"`, a case failure exactly as on the host path); the outer
  subprocess deadline only bounds container spawn/teardown, so an outer
  expiry, a docker CLI/daemon fault (exit 125–127 with a docker/OCI
  stderr signature), or a missing binary is a `VerifierError` →
  verifier RunFailure.
- `verify_stage`/`run_checkpoint_family`/`run_ce_experiment` take an
  `execute: CaseExecution` seam. The host path was renamed
  `run_case_trusted` and documented as trusted-code-only; admission
  gates run reference builds (our own code) through it. The *live*
  screening branch constructs the sandbox unconditionally — there is no
  host-execution fallback on that path, and mutant M15 proves removing
  it kills the suite.
- Real-container integration tests (skipped when Docker or the pinned
  image is absent; both present locally) run a gold stage end to end
  and a containment probe whose sealed case passes only if the network
  is unreachable and the rootfs is unwritable from inside.

### Offline dry-run (`src/parallax/checkpoint_screening.py`)

- `run_ce_screening(mode="dry-run" | "live", ...)` drives the full
  screening path: fixture load → admission → manifest → both arms ×
  trial seeds → delivery → adapter (through the real provider wire
  models against a scripted HUD-gateway transport) → verification →
  receipts → canonical evidence JSONL. The dry run needs no API key and
  makes no network calls; even-indexed stages reply inside an exact
  ```json fence so the fence unwrap is exercised in committed evidence.
- Live mode adds: spend approval (`SpendApprovalRequired` unless
  `approve_spend=True`, upper-bound estimate against the repo's $5
  cap), a per-call affordability check in the agent factory (a stage
  that could exceed the cap raises `BudgetError` before any request),
  the reported-model drift check (`claude-haiku-4-5-20251001` expected,
  drift → agent RunFailure), and the mandatory sandbox.
- Execution identity (`trusted-fixture` vs `sandbox:<image@digest>`) is
  bound into `model_config_digest`, so evidence records which
  verification path produced them.
- Committed evidence (`evidence/`): `dry-run.jsonl` — the full
  preregistered 10-seed shape, 20 runs, 60/60 stages verified,
  estimated cost $0; `dry-run-sandbox.jsonl` — 2 seeds routed through
  the real pinned Docker sandbox, 12/12 stages verified (84 container
  executions).

### Gauntlet extension

Ten new mutants (M15–M24) cover the new invariants: sandbox bypass on
the live path, network isolation dropped, rootfs writable, in-container
timeout reclassified, docker faults regraded as verdicts, truncation no
longer a budget fault, usage dropped before the receipt, reported-model
drift accepted, fence unwrap disabled, spend approval removed.

## Live screening run (2026-08-03, approved)

- Preflight: branch tip `ebff19e`, clean tree; `HUD_API_KEY` present in
  the login shell (verified non-revealing); Docker daemon up with the
  pinned sandbox image already local.
- Launched from `parallax/` under `caffeinate -dims`:
  `uv run python research/checkpoint-evolution-slice/run_screening.py
  --live --approve-spend`. Completed in 5 m 38 s (22:33:46–22:39:24 PT),
  no retries, no gateway errors, no interruption.
- Monitoring false alarm worth recording: mid-run, `docker events
  --since 3m --until 1s` returned empty and a `sample` of the process
  showed it blocked in an SSL read, which together looked like a hung
  gateway connection. Independent probes (models endpoint, minimal
  completion, the exact stage-1 body via curl, and a direct
  `urllib` call with the Python user agent) all answered in ≤ 2.5 s,
  and the run then finished on schedule — the `docker events` window
  arguments were producing empty output regardless of activity, and
  the stack sample had simply caught a normal in-flight provider call.
  Lesson: verify the observability query against known activity before
  trusting its silence.
- Outcome summary (details in [screening-report.md](screening-report.md)):
  60/60 stage calls delivered and validated; receipt digest chain
  confirmed for all 60; stages 1–2 strict in both arms on all seeds;
  stage 3 split completely — carry-reference 10/10 strict, evolved
  10/10 budget RunFailures (replies 4802–4864 bytes over the 4096-byte
  workspace cap). RunFailure rate 16.7% (< 30% stop rule), zero
  infrastructure failures. Spend $0.2813 vs the $0.25–$0.50 estimate
  and $5 cap; the evolved arm cost 1.6× the carry arm because its own
  accumulated verbosity returns as billed input tokens.
- Analysis artifacts: `summarize_screening.py` validates every record
  against the typed models, re-derives the digest chain, and writes
  `evidence/screening-summary.json`; the per-seed table and bounds-only
  contrast in the report come from it verbatim.
- Decision per the preregistered rule: **proceed** to multi-family
  synthesis (S1–S6). Flag for the next preregistration: the uniform
  stage-3 budget failure says the byte cap interacts with reply format
  (full file map) and model verbosity; cap choice and delta-style
  replies must be preregistered questions, not incidental settings.

## Budget-headroom disambiguation (2026-08-03, follow-up)

- The flag above got upgraded to a confound diagnosis: the evolved arm
  is the only arm that must re-serialize its own accumulated workspace
  in every full-file-map reply, so the flat 4096-byte cap made the
  arms nominally matched but effectively unmatched — the budget
  guaranteed for new stage content is the *cap increment*, which flat
  caps set to zero. The 10/10 stage-3 budget failures could be either
  real degradation or pure instrument. Worth $0.30 to know which.
- Lever choice: raise the mechanical output ceiling only (caps
  4096/8192/12288 plus max output tokens 2048→4096, since a maximal
  legal 12288-byte reply cannot fit in 2048 tokens), keep the
  full-file-map reply format, same seeds/specs/cases/references/model.
  The delta-reply lever stays unpulled so the variant changes exactly
  one thing.
- Structural enforcement added first: `budget_headroom_violations`
  (stage-1 cap ≥ 2× stage-1 reference; every cap increment ≥ 2× the
  reference increment) with `BudgetMatchingError` refusal on the live
  screening path. The original family fails it at stages 2 and 3, so
  the gate would have caught this confound before the first paid call.
  Gauntlet extended to 25 mutants (M25: refusal removed — killed);
  M15's patch target refreshed after the live-path edit made it
  NOT APPLICABLE (the gauntlet's target-occurrence check caught the
  staleness loudly, as designed).
- Preregistered (PREREGISTRATION-HEADROOM.md, committed at `a7c21a8`
  with dry-run evidence 60/60 at $0) before the paid run. Full gate
  first: 216 tests, ruff, ty, 25/25 mutants.
- Outcome: **H-instrument, decisively.** Evolved strict 10/10 at every
  stage, verdict-identical to carry (paired bounds [0, 0] at stages 2
  and 3), zero RunFailures, $0.2796. The original separation was our
  cap schedule, not self-accumulation. Details and the three-way
  comparison in disambiguation-report.md; the first report now carries
  a superseded banner on its headline contrast.
- What survives: evolved workspaces still bloat (stage 3: 2601–4851
  bytes vs carry's uniform 2082) and cost 1.52× carry — accumulation
  is real but lands in cost/bloat (Class B territory), not in
  verification, at this scale.
- Monitoring postmortem from the first run resolved: the silent
  `docker events` probe failure was a wrong template field
  (`{{.Status}}` instead of `{{.Action}}`) with stderr discarded, plus
  UTC timestamps that docker read as local. Probe validated against
  live activity this run (36 containers/2 min observed mid-run).
- Summarizer bug found while regenerating: it wrote every summary to
  the hardcoded name `screening-summary.json`, so the variant summary
  clobbered the original's. Fixed to derive `<stem>-summary.json`;
  both summaries regenerated from their evidence.
