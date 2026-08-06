# NOTES — strive

Working log for the initial vertical slice of the self-evolving agent harness.

## 2026-08-06 — kickoff

Goal: independent top-level project `strive/` implementing the loop
`execute → observe → evaluate → diagnose → propose → validate → accept/reject → retain → repeat`
as a thin but real vertical slice.

### Design decisions for slice v0

- **Task domain**: "sum all signed integers appearing in a text string." Fully
  deterministic, no network, trivially evaluable, and it admits a *planted
  weakness*: a naive strategy using regex `\d+` silently drops the minus sign
  on negative numbers.
- **Mutable surface = executable strategy code.** A strategy is a standalone
  Python source file exposing `solve(input_text: str) -> int`. The generation
  ledger stores full source per generation. This satisfies the requirement
  that at least one evolvable surface is code, not a prompt.
- **Isolation**: candidate (and baseline) strategy code always runs in a child
  process (`python -I strategy_runner.py <strategy.py>`), talking JSON over
  stdin/stdout, with a hard `subprocess` timeout. Not a security sandbox —
  charter marks that as a non-goal for this milestone — but it does mean a
  hanging or crashing candidate cannot take down the controller.
- **Diagnosis is evidence-based, not oracle-based**: the diagnoser only looks
  at the trace (which cases failed, their inputs/outputs/errors) and fires the
  `negative-integers-dropped` weakness only when every failing case contains a
  `-digit` pattern and there were no exceptions. If failures don't match a
  known signature, no proposal is made (honest "don't know").
- **Proposal is bounded**: a registry maps weakness id → a single textual
  patch that must match exactly once in the parent source, otherwise the
  proposer abstains. No open-ended code generation in v0 (no model calls at
  all — tests must run offline).
- **Acceptance rules are explicit**: candidate sandbox run must succeed, score
  must be strictly greater than baseline, and there must be no regression
  (every case the baseline passed must still pass).
- **Persistence**: append-only JSONL ledger (`generation` + `activation`
  entries) plus one source file per generation. The active generation is
  *derived* by scanning activation entries, so restart persistence is free and
  rollback is just a new activation entry pointing at the parent — nothing is
  ever deleted, full lineage is auditable.
- **Observability**: every cycle gets a run directory with an `events.jsonl`
  structured event stream (cycle_started, case_executed, evaluated,
  weakness_detected, candidate_proposed, validated, decision, activation,
  cycle_completed).

### Things tried / learned along the way

- `uv sync` failed on first run because `pyproject.toml` declared
  `readme = "README.md"` before the README existed — hatchling validates the
  readme path at build time. Wrote the README, then sync/build worked.
- 23 tests passed and `mypy --strict` came back clean on the first full run.
  The riskiest part (escaping the regex patch target `r"\d+"` through three
  layers of string literals — Python source, patch registry, generated file)
  was worth double-checking; the propose unit test pins it.
- Deriving the *active generation* from the last `activation` entry in the
  append-only ledger (instead of a mutable pointer file) made three
  requirements fall out for free: restart persistence (reopen and scan),
  rollback (append an activation naming the parent), and auditability
  (activations, including rollbacks, are themselves history).
- Decision: the child runner treats a raising strategy as a *per-case* error
  (`ok=True`, error recorded) but a strategy that can't even be exec'd as a
  child failure (`ok=False`). This keeps "your code is wrong" distinct from
  "your code is not runnable" in the trace, which diagnosis relies on: the
  negative-integers signature requires `error is None` + overestimate.
- The diagnoser requires at least one *passing* case before it will name a
  weakness — total failure is treated as "cause unknown" rather than risking a
  confident misdiagnosis from a degenerate trace.
- Built a committed demo ledger (`artifacts/demo/`) by driving the real CLI
  through run → run → status → rollback → status → run across separate
  processes; the transcript doubles as evidence for restart persistence and
  rollback. After rollback, the third run re-evolved the seed into `gen-0002`
  with `gen-0000` as parent — branching lineage worked without special-casing.

### Verification snapshot (2026-08-06)

- `uv run pytest -q` → 23 passed.
- `uv run mypy` (strict, src + tests) → no issues in 17 files.
- Demo: baseline score 0.571 → candidate 1.000, ACCEPTED; rollback + re-run
  journaled as branching lineage (see `artifacts/demo/transcript.txt`).
