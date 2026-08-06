# HANDOFF — strive

State of the project as of 2026-08-06, after the first vertical slice.

## What works

- **The full loop, end to end**: `execute → observe → evaluate → diagnose →
  propose → validate → accept/reject → retain` runs as one cycle
  (`loop.run_cycle`), demonstrated by tests and by the committed demo ledger
  in `artifacts/demo/` (see `transcript.txt` there).
- **Executable-code evolution**: the evolvable surface is a real Python
  strategy file, not a prompt. The seed strategy's planted weakness (unsigned
  integer regex) is detected from trace evidence only, patched by a bounded
  proposal, validated in a fresh subprocess, and accepted 0.571 → 1.000 with
  zero regressions.
- **Out-of-process execution with a hard timeout**: all strategy code —
  incumbent and candidate — runs via `python -I strategy_runner.py` with
  `subprocess` timeouts. Hangs, crashes, syntax errors, and wrong-type outputs
  are all contained and recorded (covered in `tests/test_sandbox.py`).
- **Durable, auditable state**: append-only JSONL ledger of `generation` and
  `activation` entries plus one source file per generation. The active
  generation is derived from the journal, so restart persistence needs no
  extra machinery; rollback is a journaled activation of the parent and is
  itself durable across restarts (covered in `tests/test_persistence.py`).
- **Quality gates**: 23 pytest tests, all offline (no network, no
  credentials), and `mypy --strict` clean across `src` and `tests`.

## Shortcuts taken (deliberate, for the slice)

- **Diagnosis is a signature registry**, currently containing exactly one
  signature. It proves the "evidence in, weakness out" interface, not general
  diagnosis.
- **Proposal is a patch lookup**, not generation. One weakness ↦ one textual
  patch that must match exactly once. There is no model anywhere in the loop.
- **Validation reuses the same case suite** used for diagnosis, so the
  candidate is evaluated on data that motivated it. Fine when cases are
  exhaustive ground truth; unacceptable once proposals are learned (overfitting
  risk). Held-out splits are the first hardening step.
- **The sandbox is fault isolation only** (`python -I`, timeout). No memory
  limits, no filesystem/network restriction. Adequate only because proposals
  come from a trusted registry today.
- **Single task, single incumbent, sequential cycles.** No population, no
  concurrency, no task suite abstraction beyond one `Task`.

## Technical debt

- `store.py` re-reads and re-parses the whole ledger on every query — fine at
  this scale, needs an index or snapshot once ledgers grow.
- Event payloads and ledger entries are ad-hoc dicts at write time; they
  should be serialized from the typed objects via one shared codec to prevent
  schema drift between `types.py` and what's on disk.
- `evaluate` hard-codes exact-integer-match scoring; scoring should be a
  property of the `Task`.
- The CLI prints strings; a `--json` output mode would make it scriptable.
- No CI configuration yet (tests are one `uv run pytest` away).

## Unresolved risks

- **Evaluation overfitting / reward hacking**: with proposals validated on the
  same cases that triggered them, a future model-backed proposer could learn
  to satisfy the suite rather than the task. Mitigation direction: held-out
  cases, mutation of the eval suite, independent regression corpus.
- **Trust-boundary erosion**: as surfaces become evolvable, pressure will
  build to evolve the evaluator or the acceptance rules. The charter forbids
  it without an independent check; that check does not exist yet.
- **Sandbox adequacy**: the moment proposals are model-generated, the current
  isolation is insufficient by the charter's own standard.
- **Lineage under multiple surfaces**: the ledger assumes one artifact per
  generation. Evolving prompt + code + policy in one cycle needs a composite
  generation representation and per-surface rollback semantics.

## Next phase: research and redesign for model-in-the-loop proposals (stage 2)

Exact scope, in order:

1. **Research** (write up in `docs/agents/research/`): survey self-improving
   agent systems and program-synthesis validation regimes — at minimum
   Gödel-machine-style self-reference limits, AlphaEvolve/FunSearch-style
   evolutionary code search, and Reflexion-style trace-driven revision — and
   extract the acceptance-rule and held-out-validation patterns they use.
2. **Redesign the proposer interface** so `propose()` becomes a pluggable
   `Proposer` protocol with two implementations: the existing registry proposer
   and a `ModelProposer` behind a `ModelAdapter` protocol (with a deterministic
   fake for tests — the offline test guarantee must survive).
3. **Split evaluation data** into visible (diagnosis) and held-out
   (acceptance) case sets, and extend `decide` to require improvement on both.
4. **Journal all proposer I/O** (prompts, completions, seeds) in the run's
   event stream so model-backed cycles remain replayable and auditable.
5. **Threat-model the sandbox** for model-generated code and pick the stage-3
   isolation mechanism (likely: no-network subprocess with rlimits now,
   container later).

Definition of done for the phase: a model-backed proposer (with a fake model
in tests) produces a patch for a *non-planted* weakness on a second task, the
candidate passes held-out validation, and every artifact needed to replay the
cycle offline is in the ledger.
