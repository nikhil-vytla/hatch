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
| Policies | pluggable, named, versioned acceptance policies recorded in every decision — `paired-deterministic@1` (durable code promotion) and `provisional@1` (scoped, monitored, expiring — refused for executable strategy-code; reserved for future explicitly low-risk non-code surfaces) |
| Models | provider-neutral `ModelAdapter` + deterministic `FakeModelAdapter`; all I/O journaled with latency and content-addressed prompt/completion artifacts, budget-metered; real adapter only via env vars (`STRIVE_MODEL_PROVIDER=openai-compatible` + base URL/key/model id) |
| Revisions (stage 3B) | dual-write mirror in a **separate append-only mirror journal** (`<task>.mirror.jsonl`): corrupt or unsupported mirrors can never block generation-native run/activation/rollback/replay/inspection. Every mirror carries a deterministic `SourceRecordRef` (schema, journal, ordinal, digest) and matching/repair go by source ref, never position; active-revision derivation follows source activation order. Projection is pinned to `generation-to-revision@1` with explicit historical descriptors and fail-closed source validation; evidence is operation-specific (legacy activations map to `decision_ref=None`; the generation's decision lives only in `MigrationProvenance`). Backfill/repair run a durable intent→progress→completed state machine (pending = completion, not parity); planning is pure and stale plans are refused; a source commit whose mirror publication fails reports the explicit `source-committed-parity-incomplete` condition. Stage 3B.1 hardened the derived side: intents pin the exact canonical source prefix (altered prefixes refuse resume; appends are fine); one operation-level lock and single-open-intent enforcement; planning fails closed before publishing anything; parity verifies the **full artifact closure** (manifests, provenance, decision evidence, pinned descriptors, source artifacts — missing derived objects repairable, corrupt ones fail closed, never overwritten); `strive parity --rebuild` quarantines a corrupt mirror journal byte-for-byte and atomically installs a rebuild from canonical history. Intent completion is prefix-scoped (later canonical records and their live mirrors are tolerated and left to a subsequent operation); stage-3B-era journals (`migration-intent@1`) are detected precisely with rebuild guidance. `strive parity [--repair|--rebuild]`, `strive revisions`, `strive migrate` |
| Reads (stage 3B.2) | **one read boundary** (`strive.reader.StateReader`) every operation reads through — cycle, compare, replay, audit, promotion, rollback, provisional resolution, proposal staleness, task/drift guards, proposal history, seeding, status, lineage, restart. Each operation captures the canonical entries **and their exact bytes in one read** (native view and `SourceSnapshot` derive from that capture), pairs the mirror capture through an optimistic read-recheck loop that retakes both if the canonical journal moved, and refreshes only after its own writes; mutations (activation, rollback, seeding, provisional confirm/revert) carry the expected head and refuse stale writes. Durable journaled modes (default `native`): `shadow` compares each supported read against the parity-grade `VerifiedRevisionSnapshot` (complete source-ref agreement both directions, recomputed projections, full artifact closure, bounded cycle-free lineage); `revision-canary` is the **revision-derived execution/read canary** — executed sources come from the verified snapshot after native comparison, identity reads are agreement-gated, and unavailable/divergent derived state opens a **durable circuit breaker** (no per-read silent fallback). The evaluated subject is an immutable, unactivated candidate overlay revision created and validated *before* evaluation; retention links back to that exact overlay (`RetentionRecord`) and verifies the retained mirror is content-identical. Evidence lives in a locked, fsynced, task-bound reader journal written in **crash-framed, hash-chained batches** (deletion/reordering/forged lines detected, never honored); each check records mode + heads at check time, one terminal outcome per subject, in `finally` with `missing` synthesized for uninstrumented paths. Repair/rebuild/version-change atomically open the breaker and reset the epoch (fail-closed); `clear-breaker` needs native/shadow + complete parity + a fresh epoch and never reactivates a canary; a journal-independent force-native override (`STRIVE_FORCE_NATIVE=1`) is the emergency kill. Canary is refused for real/unsafe model-generated code (same-UID sandbox). Enablement requires current-epoch eligibility: complete parity, zero divergences/errors, minimum total + per-subject samples, and observed accepted/rejected/no-candidate/rollback/re-promotion/audit/replay/restart paths. Activation and durable promotion remain generation-native. `strive reader [status\|native\|shadow\|canary\|kill\|clear-breaker\|force-native\|lift-force\|reset-journal]` |
| Revision lifecycle (stage 3B.3) | **the canonical owner of native composite revisions** (`strive.lifecycle`, `<task>.revisions.jsonl`), separate from the generation ledger and the mirror (both now explicitly derived compatibility), written in crash-framed, hash-chained, expected-head batches (shared `strive.framing` — tamper-EVIDENT, not same-UID secure). **Identity is separated from evidence**: `RevisionRetained` pins the EXACT evaluated `HarnessRevision` by CAS ref (identity only); `RevisionEvaluated`/`RevisionSelected` are appended per assessment (one revision evaluated repeatedly under different baselines), with all evidence refs validated; promote-like activation requires the CURRENT accepted selection against the active baseline, and rejected/evidence-free revisions activate only through a durable `TrustedOverride`. The pre-evaluation candidate overlay is retained unchanged for **both rejected and accepted** candidates; on acceptance the SAME revision is activated (evaluated id == retained id == activated id) through **one recoverable cross-journal operation** (`ActivationIntent`/`Progress`/`Completed` spanning the generation compatibility activation and the lifecycle activation): identity + evidence persist before served behavior changes, every crash point reconciles (abandon / resume / revert+breaker), and a lifecycle failure after generation activation is never swallowed. Validation replays the **parent ScopeManifest**: every `delta.before` must match, transitions apply, unchanged bindings carry over, and the child manifest must equal the result exactly — undeclared changes, stale before-states, and dropped surfaces fail closed (a code-only child of a code+prompt parent preserves the prompt). Whole-revision rollback drives BOTH journals (served strategy changes too); `compat_parity` exposes lifecycle/served agreement. Framed journals refuse appends over unverified regions; recovery = durable quarantine + truncation to the last verified boundary. Migrations: `0003-lifecycle-backfill` (identities + full activation replay, preserving the ACTUAL active revision) and `0004-reader-journal-upgrade` (exact PR#43 journal → shared framing, bytes preserved, loud on ambiguity). Lifecycle authority is refused for unsafe model-generated code. `strive lifecycle [status\|rollback\|repair]` |
| Prompt surface (stage 3C.1) | **the second evolvable surface is operational, with surface-specific evidence**: `prompt/proposal-template` (descriptor `prompt@3`, materializer kernel-text@1, `prompt-template@1` validator — string.Formatter parsing, exact placeholder names only, no traversal/conversions/format-specs, bounded size/repetition, required output fields) is pinned into lifecycle state at seeding (`rev-prompt-default`, journaled override), resolved from revision history for every proposal (`resolve_active_prompt`; corruption/missing/invalid = structured failures; built-in fallback only for explicitly unmigrated pre-prompt history), journaled per model request (prompt ref + lifecycle head + exact consumed bytes; post-call staleness rejects concurrent activations), bounded when rendered BEFORE any provider call, and restored with strategy code by restart and whole-revision rollback — including rollback to the pinned historical default. Proposals carry generic typed `surface_updates` keyed by descriptor ref (kernel-screened). A composite's prompt delta must earn its own evidence: the trusted `strive.promptgate` comparison runs candidate vs incumbent templates under matched adapter/context/budgets and the composite activates only when the code passes the task gate AND the prompt strictly improves proposer behavior; otherwise the code-only sibling activates and the composite is retained as rejected evidence (`SurfaceEvidence` linked to the exact revision). `strive experiment` runs the matched-arm causal experiment (A/B prompt flip, C/D ablations, E **two-stage self-produced composite**: incumbent proposer proposes p1, p1 generates s1 in a fresh fixed-budget call, the immutable p1+s1 revision is built before evaluation and the SAME id is evaluated/retained/activated/restarted/replayed/rolled back) over normal metered paths, persisting an `ExperimentManifest` in a unique run directory (reuse refused); `passed` requires the causal flip, matched configuration, journaled consumption proof, and the exact identity chain. **The offline fixture proves causal pipeline wiring, not model capability**; `--real-model` records honest SINGLE-TRIAL outcomes with tokens/latency/cost |
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

Candidate code runs outside the controller: a separate `python -I` process
with a hard timeout, a private temp workspace as cwd, a scrubbed environment
(no inherited variables, hence no inherited secrets), bounded stdout/stderr,
and POSIX rlimits (CPU, file size, open files). That is **fault containment,
not a security sandbox**: network access is not denied (no reliable
unprivileged cross-platform mechanism), address-space limits are unreliable on
macOS, and a candidate that guesses absolute paths can touch anything the
controller's UID can. Do not run untrusted third-party candidates on this
boundary. Kernel-level confinement (Landlock/seccomp, then containers) is
roadmap stage 3/6.

Two further honest caveats. First, **hidden evaluation data reaches candidate
code at execution time**: the runner sends every selection case's *input*
(never expected outputs) to the strategy process, so a malicious candidate
could read raw held-out/regression/adversarial inputs while running; holdout
isolation is mechanical for *proposers*, not for executing candidates, until
stronger sandboxing exists. Second, the store assumes **single-writer
operation** per task: an advisory file lock serializes same-host appends and
activations take an expected-incumbent head check, but concurrent multi-host
writers are out of scope.

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
