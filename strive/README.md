# strive

A self-evolving agent harness. Long-term mission: a robust, extensible,
observable, safe, and empirically validated system in which an agent improves
its own strategies by learning from evidence of its own behavior. The current
code is the first thin vertical slice of that mission — an early milestone,
not the final scope. See [docs/PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md)
for the full charter and maturity roadmap, and
[docs/HANDOFF.md](docs/HANDOFF.md) for current state, debt, and next phase.

## The loop

```
execute → observe → evaluate → diagnose → propose → validate → accept/reject → retain → repeat
```

Each stage is a separate typed module with a narrow interface, so richer
implementations (model adapters, tool use, recursive delegation, multiple
evolution strategies, real sandboxing) can replace the v0 ones without
changing the loop.

| Stage | Module | v0 implementation |
|---|---|---|
| execute | `sandbox.py` | run strategy code in a child process (`python -I`) with a hard timeout |
| observe | `events.py` | append-only JSONL event stream per run |
| evaluate | `evaluate.py` | fraction of deterministic cases passed |
| diagnose | `diagnose.py` | match failing-case evidence against known weakness signatures; abstain otherwise |
| propose | `propose.py` | one bounded code patch per weakness; abstain if the patch doesn't fit |
| validate | `loop.py` | run the candidate in its own sandboxed process on the full suite |
| accept/reject | `decide.py` | strict score improvement AND zero regressions |
| retain | `store.py` | append-only ledger with full source, decisions, lineage, activations |

The evolvable surface in v0 is **executable strategy code** (a Python file
exposing `solve(input_text: str) -> int`), not a prompt. Candidate code never
runs inside the controller process.

## Quick start

```bash
cd strive
uv sync
uv run pytest              # offline; no network or credentials required
uv run mypy                # strict typing

uv run strive run          # one evolution cycle (seeds gen-0000 on first use)
uv run strive status       # active generation + lineage
uv run strive history      # full ledger journal
uv run strive rollback     # reactivate the parent generation
```

The first `strive run` seeds a deliberately naive baseline (drops the minus
sign on negative integers), watches it fail the negative-number cases,
diagnoses `negative-integers-dropped` from the trace, proposes a one-line
regex patch, validates it in a fresh sandbox, accepts it (score 0.571 → 1.000,
no regressions), and journals the new generation. A second run finds no
weakness and proposes nothing. State survives restarts because the active
generation is derived from the append-only ledger; `rollback` is just a new
activation entry pointing at the parent — nothing is ever deleted.

## Layout

```
strive/
├── src/strive/          typed source (py.typed, mypy --strict)
├── tests/               pytest suite — deterministic, offline
├── docs/
│   ├── PROJECT_CHARTER.md   research questions, surfaces, quality attributes, non-goals
│   ├── ARCHITECTURE.md      target platform design (trusted kernel, surfaces, dual loops)
│   ├── ROADMAP.md           staged maturity targets with exit criteria
│   ├── HANDOFF.md           conclusions, decisions D1–D14, hardening priorities
│   └── agents/research/     research notes 01–06 (pinned SHAs) + comparative matrix
├── artifacts/           ledgers, per-generation strategy sources, run event streams
├── NOTES.md             working log
└── README.md
```

A committed demo ledger lives in `artifacts/demo/` as a concrete example of
the retained lineage; tests write only to temporary directories.
