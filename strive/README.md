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
| Scoring | task-owned scoring; visible / held-out / regression / adversarial splits; evaluations carry numeric per-split scores plus structured feedback |
| Failure | failure-as-data: crashes, hangs, floods, malformed output, schema mismatches, and exhausted budgets become recorded outcomes, never controller exceptions |
| Budgets | trusted kernel-side meter: wall time, executions, model calls, tokens, output bytes, cost, recursion depth |
| Attribution | every execution event records the generation that served it |
| Monitors | trusted mechanical stall detector; freeze halts adaptation (not evaluation); operator `resume` lifts it; all journaled |
| Isolation | holdout data is mechanically absent from diagnosis/proposal inputs (`VisibleContext`) |
| Policies | pluggable, named, versioned acceptance policies recorded in every decision — `paired-deterministic@1` (durable code promotion) and `provisional@1` (scoped, monitored, expiring low-risk activation) |
| Models | provider-neutral `ModelAdapter` + deterministic `FakeModelAdapter`; all I/O journaled with latency and content-addressed prompt/completion artifacts, budget-metered; real adapter only via env vars (`STRIVE_MODEL_PROVIDER=openai-compatible` + base URL/key/model id) |
| Proposals (stage 2b) | pluggable `Proposer` protocol: deterministic `registry` reference + evidence-driven `ModelProposer`; structured proposal schema (parent, rationale, trace evidence, expected outcome, full source, risks, assumptions); strict classification of bad responses (truncated / malformed / schema-invalid / forbidden / stale / budget-exhausted), each journaled distinctly; stale proposals rejected when the incumbent changed mid-proposal |

## Quick start

```bash
cd strive
uv sync
uv run pytest              # 77 tests, offline; no network or credentials
uv run mypy                # strict typing, src + tests

uv run strive run                      # one evolution cycle (seeds gen-0000 first)
uv run strive --task max-integers run --proposer model
                                       # model-backed cycle (offline fake adapter
                                       # unless STRIVE_MODEL_PROVIDER is set)
uv run strive status                   # active generation, freeze state, diagnostics
uv run strive lineage                  # active generation back to seed
uv run strive inspect --generation ID  # record + decision + source
uv run strive inspect --run RUN_ID     # cycle record + event stream
uv run strive inspect --run RUN_ID --type model_call   # filter model/proposal events
uv run strive compare GEN_A GEN_B      # paired evaluation under the policy
uv run strive replay RUN_ID            # re-execute a recorded run, diff scores
uv run strive promote GEN_ID           # durable promotion (paired evidence required)
uv run strive promote GEN_ID --provisional --expires N
uv run strive rollback                 # reactivate the parent (journaled)
uv run strive resume                   # lift a stall freeze
uv run strive history                  # full ledger journal
```

Every command accepts `--json` for a machine-readable envelope
(`{"ok": ..., "command": ..., "data" | "error": ...}`); failures exit 1 with a
clean diagnostic, never a traceback. Demo ledgers produced by the real CLI are
committed at `artifacts/demo/` (registry proposer, sum-integers) and
`artifacts/demo-model/` (model proposer with the offline fake, max-integers —
including an exact offline replay that reproduces the promotion decision).

**Fake-model honesty:** the offline fake adapter demonstrates that the
*pipeline* is correct — prompt construction from visible evidence only, strict
schema validation, forbidden-source screening, sandboxed validation, gated
promotion, journaling, replay. It does not demonstrate model capability: its
responses are deterministic fixtures. Real-model results are opt-in via
environment variables and carry the capability-dependence caveats in
`docs/HANDOFF.md`.

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

## Layout

```
strive/
├── src/strive/
│   ├── contracts.py   versioned typed contracts (kind@version)
│   ├── codec.py       one shared strict codec for memory + disk
│   ├── cas.py         content-addressed object store
│   ├── store.py       append-only ledger, activation, lineage
│   ├── tasks.py       task-owned scoring + case splits
│   ├── sandbox.py     out-of-process execution (see isolation note)
│   ├── budget.py      trusted budget meter
│   ├── policy.py      pluggable acceptance/promotion policies
│   ├── monitors.py    trusted stall detection
│   ├── model.py       provider-neutral model interface, fake + env-only real adapter
│   ├── model_proposer.py  evidence-driven proposer + strict response classification
│   ├── fakemodel.py   deterministic reference responses for demos/tests
│   ├── diagnose.py    visible-evidence diagnosis (signature + generic; holdout-isolated)
│   ├── propose.py     Proposer protocol, registry reference, trusted source screen
│   ├── evaluate.py    split-aware scoring + feedback
│   ├── loop.py        the trusted kernel orchestrator
│   └── cli.py         human + machine-readable CLI
├── tests/             91 tests incl. failure injection — offline, deterministic
├── docs/              charter, architecture, roadmap, handoff, research notes
├── artifacts/demo/        committed demo ledger + transcript (registry proposer)
├── artifacts/demo-model/  committed demo ledger + transcript (model proposer, fake)
└── NOTES.md           working log
```
