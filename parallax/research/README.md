# Parallax research trails

One subfolder per investigation. Each holds a `NOTES.md` chronology, a
`README.md` report, a `_summary.md`, and whatever code and evidence the work
produced. Durable current-state contracts live in [`../docs/`](../docs/); folders
here record how the work got there and are not maintained after the
investigation closes.

For results without the chronology, read [`../docs/FINDINGS.md`](../docs/FINDINGS.md).

New investigations committed against `main` create their folder here. The former
`hard-repo-tasks/` namespace is the archive of a superseded experiment and lives
only on its [archive branch](https://github.com/nikhil-vytla/hatch/pull/5). Do
not recreate it on `main`.

## Runs with evidence

Dated folders. Each one spent money or compute and committed the receipts.

- [`swebench-screening-run-20260802/`](swebench-screening-run-20260802/README.md)
  Screening round 1. Five instances, two static Opus 4.8 trials each. Found two
  ceilings and three floors, no boundary. Also the folder where the verifier
  isolation rework and the evaluator-side grading topology were forced by an
  adversarial review.
- [`swebench-screening-round2-20260803/`](swebench-screening-round2-20260803/README.md)
  Screening round 2. Covered the rest of the medium-difficulty stratum and found
  the three boundary instances every later run uses.
- [`swebench-experiment-prerequisites-20260803/`](swebench-experiment-prerequisites-20260803/README.md)
  Harness-owned turn delivery, the six admission gates, and the real G3/G4 runs
  that admitted those three instances. Also holds the preregistered 18-unit
  design.
- [`swebench-single-vs-evolved-20260803/`](swebench-single-vs-evolved-20260803/README.md)
  The 18-unit experiment. Three defective sessions before a clean run; the
  incident log is the most useful thing in the folder.

## Design and survey work

No runs, no spend. These produced specifications and decisions that later code
implemented.

- [`upstream-design-audit/`](upstream-design-audit/README.md) Checked three
  Parallax design choices against the upstream papers and code. Established that
  the three-arm paired design is our addition, surveyed how task-generation
  efforts actually do QC, and caught the agent-callable `advance()` tool as an
  undeclared deviation from upstream turn delivery.
- [`admission-qc/`](admission-qc/README.md) Specified the six in-code admission
  gates and the judgment-side
  [`review-task-admission`](../.cursor/skills/review-task-admission/SKILL.md)
  skill. The gates are now implemented in `src/parallax/admission.py`.
- [`spec-translation/`](spec-translation/README.md) Designed the minimal spec
  layer that compiles Parallax task and environment specifications to RL
  platforms, with structural sealing and a cross-platform conformance check. Now
  implemented as `specs.py`, `hud_compile.py`, and `conformance.py`.
- [`slopcodebench-method/`](slopcodebench-method/README.md) Formal model,
  quality-measurement audit, research questions, and synthesis workflow behind
  [`../docs/methods/checkpoint-evolution.md`](../docs/methods/checkpoint-evolution.md).
