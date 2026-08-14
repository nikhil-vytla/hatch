# strive

A self-evolving agent harness. Long-term mission: a robust, extensible,
observable, safe, and empirically validated system in which an agent improves
its own strategies by learning from evidence of its own behavior. See
[docs/PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md) for the charter,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the platform design,
[docs/ROADMAP.md](docs/ROADMAP.md) for staged targets, and
[docs/HANDOFF.md](docs/HANDOFF.md) for current state and next phase.

## The loop

```
execute → observe → evaluate → diagnose → propose → validate → accept/reject → retain → repeat
```

The evolvable surface is **executable strategy code** (a Python file exposing
`solve(input_text: str) -> int`), never imported into the kernel process. The
loop is gated: candidates are promoted only on trusted, journaled evidence.

## Hardened core (phase 3)

| Concern | Mechanism |
|---|---|
| Contracts | versioned typed dataclasses (`contracts.py`), one shared codec (`codec.py`), strict + loud rejection of malformed/unsupported records, golden-record compatibility tests |
| History | append-only ledger (single-write + fsync appends); torn final line tolerated as a crash artifact, interior corruption is a loud error; content-addressed object store with read-time verification |
| Promotion | atomic by construction (one activation line); paired incumbent/candidate evidence required for durable promotion; journaled rollback; complete lineage |
| Scoring | task-owned scoring; visible (train) / held-out+regression+adversarial (development/selection) / audit (final holdout — an *operationally separate* split queried only via `strive audit`, never during selection; not secret or access-controlled, and like all case inputs it reaches candidate code at execution time) splits; evaluations carry numeric per-split scores plus structured feedback; proposer-facing history reports visible-split movement only |
| Failure | failure-as-data: crashes, hangs, floods, malformed output, schema mismatches, and exhausted budgets become recorded outcomes, never controller exceptions |
| Budgets | trusted kernel-side meter with uniform semantics (0 = nothing allowed, -1 = accounting only). Hard-enforced: wall time, executions, model calls, cumulative output bytes. Tokens: enforced between calls plus a requested-output cap — one call's *input* tokens can overshoot, in which case the overrun is charged, journaled, and its completion rejected before it can become a proposal. Cost: enforced only against adapters that report trustworthy cost (fail-closed otherwise; the OpenAI-compatible adapter does **not** report cost). HTTP timeouts capped by remaining wall time; per-limit semantics journaled every cycle |
| Attribution | every execution event records the generation that served it |
| Monitors | trusted mechanical stall detector; freeze halts adaptation (not evaluation); operator `resume` lifts it; all journaled |
| Isolation | holdout data is mechanically absent from diagnosis/proposal inputs (`VisibleContext`) |
| Secure sandbox (stages 3C.2B + 3C.2B.1) | one kernel-owned `CandidateExecutor` over a pluggable versioned `SandboxBackend` boundary, resolved from an **injected immutable catalog** (fail-closed, never downgrades): `process-fault-only@1` (trusted fixtures only — the executor refuses untrusted code on it), `deno-pyodide@1` (**shipping secure local backend** — Deno+Pyodide WASM: no host filesystem/network/env/subprocess, fresh interpreter per case, only `input_text` in a separate namespace, strict single-typed result, POSIX-rlimit launcher + wall-clock hard-kill so `resource_limited` is enforced), and an always-unavailable Linux Landlock/seccomp spike. Provenance pins exact Deno/Pyodide/DSPy/runner digests; the activation gate checks cross-bundle agreement; replay requires the recorded backend or reports unavailable. `strive sandbox`, `strive capability`, `--sandbox-backend` on run/compare/replay/audit/promote |
| Policies | pluggable, named, versioned acceptance policies recorded in every decision — `paired-deterministic@1` (durable code promotion) and `provisional@1` (scoped, monitored, expiring — refused for executable strategy-code; reserved for future explicitly low-risk non-code surfaces) |
| Models | provider-neutral `ModelAdapter` + deterministic `FakeModelAdapter`; all I/O journaled with latency and content-addressed prompt/completion artifacts, budget-metered; real adapter only via env vars (`STRIVE_MODEL_PROVIDER=openai-compatible` + base URL/key/model id, incl. local vLLM/Ollama-compatible servers) |
| Capability lane (stages 3C.2B + 3C.2B.1) | `strive.capability`: repeated trials with the **real per-trial seed propagated into every `ModelRequest`** (the adapter's seed support recorded honestly), executed inside the secure backend, persisting one **immutable manifest** of per-trial request/prompt/completion/revision/evidence/sandbox/budget/outcome refs, judged against a **preregistered criterion** (min trials + clean-acceptance with an interval lower bound > 0, so one lucky success is never `supported`), and **resumable** without duplicate spend. Fixtures and single trials are never capability evidence; the scripted fixture stays the deterministic control, labeled `inconclusive` |
| Revisions (stage 3B) | dual-write mirror in a **separate append-only mirror journal** (`<task>.mirror.jsonl`): corrupt or unsupported mirrors can never block generation-native run/activation/rollback/replay/inspection. Every mirror carries a deterministic `SourceRecordRef` (schema, journal, ordinal, digest) and matching/repair go by source ref, never position; active-revision derivation follows source activation order. Projection is pinned to `generation-to-revision@1` with explicit historical descriptors and fail-closed source validation; evidence is operation-specific (legacy activations map to `decision_ref=None`; the generation's decision lives only in `MigrationProvenance`). Backfill/repair run a durable intent→progress→completed state machine (pending = completion, not parity); planning is pure and stale plans are refused; a source commit whose mirror publication fails reports the explicit `source-committed-parity-incomplete` condition. Stage 3B.1 hardened the derived side: intents pin the exact canonical source prefix (altered prefixes refuse resume; appends are fine); one operation-level lock and single-open-intent enforcement; planning fails closed before publishing anything; parity verifies the **full artifact closure** (manifests, provenance, decision evidence, pinned descriptors, source artifacts — missing derived objects repairable, corrupt ones fail closed, never overwritten); `strive parity --rebuild` quarantines a corrupt mirror journal byte-for-byte and atomically installs a rebuild from canonical history. Intent completion is prefix-scoped (later canonical records and their live mirrors are tolerated and left to a subsequent operation); stage-3B-era journals (`migration-intent@1`) are detected precisely with rebuild guidance. `strive parity [--repair|--rebuild]`, `strive revisions`, `strive migrate` |
| Reads (stage 3B.2) | **one read boundary** (`strive.reader.StateReader`) every operation reads through — cycle, compare, replay, audit, promotion, rollback, provisional resolution, proposal staleness, task/drift guards, proposal history, seeding, status, lineage, restart. Each operation captures the canonical entries **and their exact bytes in one read** (native view and `SourceSnapshot` derive from that capture), pairs the mirror capture through an optimistic read-recheck loop that retakes both if the canonical journal moved, and refreshes only after its own writes; mutations (activation, rollback, seeding, provisional confirm/revert) carry the expected head and refuse stale writes. Durable journaled modes (default `native`): `shadow` compares each supported read against the parity-grade `VerifiedRevisionSnapshot` (complete source-ref agreement both directions, recomputed projections, full artifact closure, bounded cycle-free lineage); `revision-canary` is the **revision-derived execution/read canary** — executed sources come from the verified snapshot after native comparison, identity reads are agreement-gated, and unavailable/divergent derived state opens a **durable circuit breaker** (no per-read silent fallback). The evaluated subject is an immutable, unactivated candidate overlay revision created and validated *before* evaluation; retention links back to that exact overlay (`RetentionRecord`) and verifies the retained mirror is content-identical. Evidence lives in a locked, fsynced, task-bound reader journal written in **crash-framed, hash-chained batches** (deletion/reordering/forged lines detected, never honored); each check records mode + heads at check time, one terminal outcome per subject, in `finally` with `missing` synthesized for uninstrumented paths. Repair/rebuild/version-change atomically open the breaker and reset the epoch (fail-closed); `clear-breaker` needs native/shadow + complete parity + a fresh epoch and never reactivates a canary; a journal-independent force-native override (`STRIVE_FORCE_NATIVE=1`) is the emergency kill. Canary is refused for real/unsafe model-generated code (same-UID sandbox). Enablement requires current-epoch eligibility: complete parity, zero divergences/errors, minimum total + per-subject samples, and observed accepted/rejected/no-candidate/rollback/re-promotion/audit/replay/restart paths. Activation and durable promotion remain generation-native. `strive reader [status\|native\|shadow\|canary\|kill\|clear-breaker\|force-native\|lift-force\|reset-journal]` |
| Revision lifecycle (stage 3B.3) | **the canonical owner of native composite revisions** (`strive.lifecycle`, `<task>.revisions.jsonl`), separate from the generation ledger and the mirror (both now explicitly derived compatibility), written in crash-framed, hash-chained, expected-head batches (shared `strive.framing` — tamper-EVIDENT, not same-UID secure). **Identity is separated from evidence**: `RevisionRetained` pins the EXACT evaluated `HarnessRevision` by CAS ref (identity only); `RevisionEvaluated`/`RevisionSelected` are appended per assessment (one revision evaluated repeatedly under different baselines), with all evidence refs validated; promote-like activation requires the CURRENT accepted selection against the active baseline, and rejected/evidence-free revisions activate only through a durable `TrustedOverride`. The pre-evaluation candidate overlay is retained unchanged for **both rejected and accepted** candidates; on acceptance the SAME revision is activated (evaluated id == retained id == activated id) through **one recoverable cross-journal operation** (`ActivationIntent`/`Progress`/`Completed` spanning the generation compatibility activation and the lifecycle activation): identity + evidence persist before served behavior changes, every crash point reconciles (abandon / resume / revert+breaker), and a lifecycle failure after generation activation is never swallowed. Validation replays the **parent ScopeManifest**: every `delta.before` must match, transitions apply, unchanged bindings carry over, and the child manifest must equal the result exactly — undeclared changes, stale before-states, and dropped surfaces fail closed (a code-only child of a code+prompt parent preserves the prompt). Whole-revision rollback drives BOTH journals (served strategy changes too); `compat_parity` exposes lifecycle/served agreement. Framed journals refuse appends over unverified regions; recovery = durable quarantine + truncation to the last verified boundary. Migrations: `0003-lifecycle-backfill` (identities + full activation replay, preserving the ACTUAL active revision) and `0004-reader-journal-upgrade` (exact PR#43 journal → shared framing, bytes preserved, loud on ambiguity). Lifecycle authority is refused for unsafe model-generated code. `strive lifecycle [status\|rollback\|repair]` |
| Prompt surface (stage 3C.1) | **the second evolvable surface is operational, with surface-specific evidence**: `prompt/proposal-template` (descriptor `prompt@3`, materializer kernel-text@1, `prompt-template@1` validator — string.Formatter parsing, exact placeholder names only, no traversal/conversions/format-specs, bounded size/repetition, required output fields) is pinned into lifecycle state at seeding (`rev-prompt-default`, journaled override), resolved from revision history for every proposal (`resolve_active_prompt`; corruption/missing/invalid = structured failures; built-in fallback only for explicitly unmigrated pre-prompt history), journaled per model request (prompt ref + lifecycle head + exact consumed bytes; post-call staleness rejects concurrent activations), bounded when rendered BEFORE any provider call, and restored with strategy code by restart and whole-revision rollback — including rollback to the pinned historical default. Proposals carry generic typed `surface_updates` keyed by descriptor ref (kernel-screened). A composite's prompt delta must earn its own evidence: the trusted `strive.promptgate` comparison runs candidate vs incumbent templates under matched adapter/context/budgets and the composite activates only when the code passes the task gate AND the prompt strictly improves proposer behavior; otherwise the code-only sibling activates and the composite is retained as rejected evidence (`SurfaceEvidence` linked to the exact revision). `strive experiment` runs the matched-arm causal experiment (A/B prompt flip, C/D ablations, E **two-stage self-produced composite**: incumbent proposer proposes p1, p1 generates s1 in a fresh fixed-budget call, the immutable p1+s1 revision is built before evaluation and the SAME id is evaluated/retained/activated/restarted/replayed/rolled back) over normal metered paths, persisting an `ExperimentManifest` in a unique run directory (reuse refused); `passed` requires the causal flip, matched configuration, journaled consumption proof, and the exact identity chain. **The offline fixture proves causal pipeline wiring, not model capability**; `--real-model` records honest SINGLE-TRIAL outcomes with tokens/latency/cost |
| Evidence & selection (stages 3C.2A + 3C.2A.1) | **versioned validation evidence and policy-neutral selection, now AUTHORITATIVE**: frozen envelopes (`strive.evidence`) — `DatasetRevision@1` (per-split CAS manifests; creation locked, expected-head checked, crash-safe with quarantined torn tails, idempotent, CAS-closure verified; growth creates a new revision and a re-evaluation requirement, never a task-drift acknowledgement), `EvaluationManifest@2` pinning the exact `ResolvedHarnessManifest`, `ExecutionRecord`, `TaskSpecVersion`, and `DatasetRevision` by CAS ref with verified fingerprints, role-bound `ValidationBundle@1`/`ValidatorResult@1`, typed `DecisionEvidence@1` + `SelectionDecision@1` (closed dispositions; every disposition requires evidence), trusted `ObjectiveSpec@1`, and the `function-task@1` spec adapter. The live mutation guard detects task-SPEC drift (`TaskSpecBound`); dataset growth passes the real guard unacknowledged and forces re-baselining. The activation gate demands the exact evaluation that produced the decision: each role's prescribed validator set one-to-one with results (no missing/extraneous/duplicate results or roles), a PASSED paired comparison (noncrashing ≠ accepted) with agreeing artifacts, matching objective specs across decision and bundles, agreeing policy/subject/incumbent, verified execution provenance (an ExecutionRecord smuggled as a resolved manifest fails the typed decode), current dataset + spec, and all seven budget dimensions within the meter's exact limit semantics. Synthetic/migrated envelopes are preserved for inspection/replay/rollback but never authorize fresh promotion — a modern re-evaluation (`selection.record_assessment`) is required. `strive evidence` exposes the full readiness verdict |
| Proposals (stage 2b) | pluggable `Proposer` protocol: deterministic `registry` reference + `ModelProposer` over the provider-neutral adapter (offline demos/tests use a *scripted proposal fixture*, not model reasoning); structured proposal schema (parent, rationale, trace evidence, expected outcome, full source, risks, assumptions); strict classification of bad responses (truncated / malformed / schema-invalid / forbidden / stale / budget-exhausted), each journaled distinctly; stale proposals rejected when the incumbent changed mid-proposal |

## Quick start

```bash
cd strive
uv sync
uv run pytest              # 115 tests, offline; no network or credentials
uv run mypy                # strict typing, src + tests

uv run strive run                      # one evolution cycle (seeds gen-0000 first)
uv run strive --task max-integers run --proposer model
                                       # model-backed cycle (offline scripted
                                       # fixture unless STRIVE_MODEL_PROVIDER is set;
                                       # real models require --unsafe-model-code)
uv run strive status                   # active generation, freeze state, diagnostics
uv run strive lineage                  # active generation back to seed
uv run strive inspect --generation ID  # record + decision + source
uv run strive inspect --run RUN_ID     # cycle record + event stream
uv run strive inspect --run RUN_ID --type model_call   # filter model/proposal events
uv run strive compare GEN_A GEN_B      # paired evaluation under the policy
uv run strive replay RUN_ID            # execution-and-decision replay (re-execute +
                                       # re-check the recorded decision; NOT a full-cycle
                                       # replay of diagnosis/prompt/proposal)
uv run strive audit [--generation ID]  # score the final audit holdout, on demand
uv run strive promote GEN_ID           # durable promotion (paired evidence required)
uv run strive promote GEN_ID --provisional --expires N
uv run strive rollback                 # reactivate the parent (journaled)
uv run strive resume                   # lift a stall freeze
uv run strive history                  # full ledger journal
uv run strive migrate-legacy           # convert a stage-2a ledger/ledger.jsonl to the
                                       # task-scoped format (original preserved)
uv run strive migrate                  # apply pending registry migrations in order
                                       # (0001 legacy ledger, 0002 revision backfill)
uv run strive parity [--repair]        # check/repair generation<->revision mirror parity
uv run strive revisions                # inspect stage-3B revision mirrors
# run/promote accept --acknowledge-task-drift when the task definition changed
# since the active generation was created (refused otherwise; journaled)
```

Every command accepts `--json` for a machine-readable envelope
(`{"ok": ..., "command": ..., "data" | "error": ...}`); failures exit 1 with a
clean diagnostic, never a traceback. Demo ledgers produced by the real CLI are
committed at `artifacts/demo/` (registry proposer, sum-integers) and
`artifacts/demo-model/` (model proposer with the offline scripted fixture,
max-integers — including an execution-and-decision replay that reproduces the
promotion decision, and cross-task runs sharing one artifact root).

**Fixture honesty:** the offline "model" path is a *scripted proposal
fixture*: the repair was written by the harness authors and is emitted by a
canned responder. It demonstrates that the pipeline is correct — prompt
construction from visible evidence only, strict schema validation,
forbidden-source screening, sandboxed validation, gated promotion, journaling,
replay — and demonstrates nothing about model reasoning or capability.
Real-model runs are opt-in via environment variables, require the
`--unsafe-model-code` acknowledgement (model-generated code executes without
network/filesystem confinement), and carry the capability-dependence caveats
in `docs/HANDOFF.md`.

## The isolation boundary, honestly

Candidate code runs through ONE kernel-owned `CandidateExecutor`
(`strive.sandboxes`; stages 3C.2B / 3C.2B.1, ADR-0007) over a pluggable,
versioned `SandboxBackend` boundary. Backends come from an **injected
immutable catalog** (name + factory descriptors), resolved by exact
name@version and **fail-closed** — a requested backend that is unavailable
raises rather than silently downgrading. `run_strategy` is never called
directly outside the fault-only backend and its tests. Three backends:

- **`process-fault-only@1`** — the `python -I` subprocess: fault
  containment, **not** security (no filesystem confinement, no network
  denial, no full resource floor). Its capability report says so, and the
  executor **refuses untrusted (model-authored) code on it** — it is for
  explicitly trusted fixtures only.
- **`deno-pyodide@1`** — the shipping **secure local** backend (DSPy's
  `PythonInterpreter` over Deno + Pyodide WASM). Default-deny filesystem /
  network / environment / subprocess; a **fresh interpreter per case**; and
  the protected protocol sends **only `input_text`** into a **separate
  candidate namespace** that cannot see the payload, the runner globals, or
  the serialization used to build the result (the parent assigns case ids
  and strictly validates one declared-type result). Deno launches through a
  POSIX-rlimit launcher (CPU/files/procs/size + a coarse memory ceiling) with
  a wall-clock hard-kill, so `resource_limited` is mechanically enforced.
  The adversarial suite runs the escape battery — read the
  repo/ledger/CAS/`~/.ssh`/env, walk frames for sibling/answer data, open
  sockets, fork, write outside the workspace, persist across cases, forge
  outcomes, patch serialization, spin forever — and every attempt is denied
  and journaled.
- **`linux-landlock-seccomp@1`** — a NOOA-derived (Apache-2.0) spike that is
  **always unavailable** on this build (its full ruleset and leak-vs-closed
  tests are not implemented); it never reports available+secure with a
  raising `run`.

`strive sandbox` reports availability and capabilities; `strive capability`
runs the model-capability lane inside a secure backend; `--sandbox-backend`
selects the boundary for `run`/`compare`/`replay`/`audit`/`promote`. Sandbox
provenance pins exact Deno/Pyodide/DSPy/runner digests; each validator pins
the boundary it used; the activation gate checks the provenance agrees
across a decision's bundles; and **replay uses the recorded backend or
reports it unavailable** — a Pyodide-contained candidate is never
re-validated in plain CPython. Lifecycle authority is granted for
model-generated code only under a mechanically-secure backend.

Protected evaluation is now isolated correctly: each
held-out/regression/adversarial/audit case runs in its own fresh sandbox and
the candidate receives ONLY that case's `input_text` — the parent keeps case
id, split, expected output, and the rest of the suite. (On the legacy
fault-only boundary, case inputs still reached the shared strategy process;
the secure backend closes that gap.) One remaining honest caveat: the store
assumes **single-writer operation** per task — an advisory file lock
serializes same-host appends and activations take an expected-incumbent head
check, but concurrent multi-host writers are out of scope.

## Layout

```
strive/
├── src/strive/
│   ├── contracts.py   versioned typed contracts (kind@version)
│   ├── codec.py       one shared strict codec for memory + disk
│   ├── cas.py         content-addressed object store
│   ├── store.py       task-scoped append-only ledgers, activation, lineage
│   ├── revisions.py   frozen stage-3B core wire types (ADR-0001/0002)
│   ├── dualwrite.py   deterministic generation->revision mirroring + parity
│   ├── migrations.py  sequential migration registry (0001 legacy, 0002 backfill)
│   ├── tasks.py       task-owned scoring + case splits
│   ├── sandbox.py     out-of-process execution (see isolation note)
│   ├── budget.py      trusted budget meter
│   ├── policy.py      pluggable acceptance/promotion policies
│   ├── monitors.py    trusted stall detection
│   ├── model.py       provider-neutral model interface, fake + env-only real adapter
│   ├── model_proposer.py  model-backed proposer (visible evidence in) + strict classification
│   ├── fakemodel.py   deterministic reference responses for demos/tests
│   ├── diagnose.py    visible-evidence diagnosis (signature + generic; holdout-isolated)
│   ├── propose.py     Proposer protocol, registry reference, trusted source screen
│   ├── evaluate.py    split-aware scoring + feedback
│   ├── loop.py        the trusted kernel orchestrator
│   └── cli.py         human + machine-readable CLI
├── tests/             115 tests incl. failure injection — offline, deterministic
├── docs/              charter, architecture, roadmap, handoff, research notes
├── artifacts/demo/        committed demo ledger + transcript (registry proposer)
├── artifacts/demo-model/  committed demo ledger + transcript (model proposer, fake)
└── NOTES.md           working log
```
