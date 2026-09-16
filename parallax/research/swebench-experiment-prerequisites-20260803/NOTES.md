# SWE-bench experiment prerequisites notes

Collapsed. This file used to restate [`README.md`](README.md) in a different
order: a scope section, a definition-of-done checklist, a numbered workflow, and
a work log whose entries said "did the thing the README describes." All of that
is gone. What is left is the material the README does not carry: where upstream
behavior was read from, what went wrong, and what was decided against.

The unit prepared the first static-versus-evolved experiment on
`astropy__astropy-14508`, `django__django-13786`, and `pydata__xarray-4695`. It
authorized local Docker compute for admission checks and no paid inference. The
experiment itself ran later, in
[`../swebench-single-vs-evolved-20260803/`](../swebench-single-vs-evolved-20260803/README.md).

## Provenance

Upstream turn delivery was characterized in PR #21 against
`microsoft/evolving-intent` commit `993d6be9597ac03854b46362ccd647eb1bfd267a`:
`evaluation/common/swe_minisweagent_scaffold.py:408-424` for the update wrapper,
`:714-749` for submission interception, `:750-787` for per-turn budget
exhaustion. Admission predicates G1 through G6 come from PR #22,
[`../admission-qc/README.md`](../admission-qc/README.md).

## The two traps that motivated the rewrite

Both were found by reading before writing, which is the only reason they were
cheap.

- **The agent-visible director was skippable.** An `advance()` tool the policy
  can call is a tool the policy can decline to call. An evolved-arm episode could
  grade itself before the intent update ever arrived, and the result would look
  like a valid evolved trial. Deleted with no compatibility layer: every caller
  was internal, and a pull API weakens the intervention by construction.
- **An empty model patch short-circuits the official harness.** With
  `patch_exists=False` the harness reports WRONG without executing tests, so a
  naive "empty submission must fail" no-op gate passes vacuously and certifies
  nothing. G3 therefore applies an inert but real identity patch, so the
  FAIL_TO_PASS tests actually run and are observed failing.

## Decisions worth keeping

- Delivery is a typed receipt with one phase record per scheduled turn,
  constructed by the harness and revalidated by the environment at grading. The
  environment receives it through the normal HUD answer channel and exports a
  candidate patch only after validating complete contiguous delivery.
- Admission evidence stores sealed fragment digests and lengths, never fragment
  bytes. An admission record that quotes the leak it found is a new leak.

## Outcome

Every identity patch applied, ran tests, and produced WRONG with zero
FAIL_TO_PASS successes. Every gold patch applied and produced PASS on the first
attempt. All three sources are `admitted` and none is `admitted_flaky`. Gates
passing first try is a pleasant surprise worth stating precisely once, which is
why the old day-by-day log added nothing.
