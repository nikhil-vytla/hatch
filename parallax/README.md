# Parallax

Parallax is a research harness for identifying modern-agent failure modes,
turning them into research questions about agent training and RL environments,
synthesizing novel or harder but verifiable tasks from existing benchmarks and
codebases, and running controlled experiments with trustworthy evidence.

The executable slice follows one complete path:

1. `gsm8k.py` loads real-shaped GSM8K JSONL and retains the canonical
   `#### <integer>` answer as a branded, sealed grading authority.
2. `evolving_intent.py` asks a synchronous `Chat` callable for strict JSON
   construction outputs and builds frozen static, matched, and evolved scripts.
   Reveal, revise, and switch events use an explicit `kind` discriminator.
   Static renders the fully revealed extracted intent rather than the source
   question. The
   matched intervention is a turn-count-and-budget-matched progressive source
   reveal.
3. `runner.py` preregisters source-trial units and identity digests, executes
   every scheduled arm, and writes deterministic JSONL through atomic
   replacement. Construction attempts and scripts appear once per source.
4. `report.py` validates every scheduled row before aggregation. It reports
   source-clustered matched-versus-evolved identification bounds, a closed-form
   95% Hoeffding interval, and an `advance`, `reject`, or `inconclusive` action.

All JSON boundaries parse into strict frozen Pydantic models with unknown fields
forbidden. Manifest, family, and run records use a `kind` discriminator, as do
events and outcomes. Canonical JSONL still uses sorted keys, compact separators,
and non-finite-number rejection; identical inputs therefore remain byte-stable.
The report consumes these typed records and reserves its own checks for
relationships across records, such as missing scheduled rows or identity drift.

`Problem.answer` never enters construction prompts or public turn text. The
native grader accepts one submission policy: the final non-empty line must be
`FINAL_ANSWER: <integer>`, with exactly one marker and a canonical integer.
Malformed submissions are invalid. Valid non-matching answers are wrong.
Provider, budget, and verifier faults are run failures.

The offline tests use small real-shaped GSM8K rows and scripted `Chat`
implementations. They exercise construction, all three arms, history-sensitive
execution, grading, manifest validation, JSONL round-trips, missing-outcome
bounds, and source-clustered reporting without network calls. Parallax has no
real-provider evidence, generated benchmark pool, or paper-score reproduction.

[`docs/MODEL.md`](docs/MODEL.md) defines the research vocabulary.
[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) records the
method contract, implementation choices, and evidence limits.

> **TODO:** Collect retained real-provider construction and run evidence before
> interpreting an empirical effect.
