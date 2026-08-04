Parallax's admission QC layer now has its research-and-specification half:
six mechanically checkable gates (schema round-trip, sealed-leakage lint,
no-op via identity patch, gold with infra-only flaky-retry, budget
matching including per-turn step splits, and arm-completeness) specified
against the actual types on the screening-run branch, plus a
`review-task-admission` project skill carrying the judgment side as five
questions rather than a checklist. The gate designs distill practice from
[Prime Intellect's verifiers](https://github.com/PrimeIntellect-ai/verifiers/blob/main/verifiers/v1/GUIDE.md)
(model-free gold validation, flaky/broken separation), the
[METR Task Development Guide](https://taskdev.metr.org/) (reviewer
independence, invalid/partial/best score probes), HUD's task-design
advice, slop-code-bench's review checklists, SWE-smith, and Anthropic's
eval guide. Reading the branch code surfaced two implementation traps the
specs defuse: the official harness short-circuits an empty patch without
running tests (so the no-op gate must submit an identity patch), and the
gold patch is currently parsed but dropped at ingestion (so the gold gate
needs one sealed-schema addition).

- The bidirectional gold/no-op pair is the field's admission bar; retries
  apply only to infrastructure failures, never to graded verdicts.
- Byte-level leakage linting is necessary but insufficient — paraphrase,
  grader-vocabulary, and eval-context leakage are judgment calls routed to
  the skill's rendered-turn review.
- Rejections are recorded, not deleted, so triage can detect selective
  rejection quietly reshaping the population between arms.
