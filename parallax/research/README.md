# Parallax research trails

Each subfolder is one investigation's research trail — the `NOTES.md`,
`README.md` report, `_summary.md`, and working analyses behind a decision or
a method doc. Durable current-state contracts live in
[`../docs/`](../docs/); folders here record how the work got there and are
not maintained as product documentation after their investigation closes.

New investigations committed against `main` create their folder here. The
former `hard-repo-tasks/` namespace is the archive of a superseded
experiment and lives only on its
[archive branch](https://github.com/nikhil-vytla/hatch/pull/5); it must not
be recreated on `main`.

- [`admission-qc/`](admission-qc/README.md) — best-practices research and
  gate specifications for the admission QC layer: six in-code gates plus
  the judgment-side
  [`review-task-admission`](../.cursor/skills/review-task-admission/SKILL.md)
  skill.
- [`slopcodebench-method/`](slopcodebench-method/README.md) — design of the
  checkpoint-evolution synthesis method behind
  [`../docs/methods/checkpoint-evolution.md`](../docs/methods/checkpoint-evolution.md).
- [`spec-translation/`](spec-translation/README.md) — research and design of
  the minimal spec layer that compiles Parallax task/environment
  specifications to RL platforms (HUD, `verifiers`) with structural sealing
  and a cross-platform conformance check.
