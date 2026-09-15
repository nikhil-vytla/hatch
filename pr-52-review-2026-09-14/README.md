# Open PR review — commit volume, PR #52 organization, merge order

Read-only review of the 7 non-draft open PRs on `nikhil-vytla/hatch` as of 2026-09-14. No PRs, branches, or repo files were modified — see `NOTES.md` for the raw data and commands used.

## Why PR #52 has 22 commits

PR #52 (`strive-astra` → `strive-vnext-phaseB`) is the Astra-led clean-slate rebuild of `strive`. Its 22 commits map essentially 1:1 to the milestones listed in its own PR body — M1 (substrate: CAS + journal + pure verifier) through M9 (live tau2 campaign runner), plus a design-fold docs commit and a session-recap commit. The 26,676 additions / 237 changed files are *not* cumulative with #51 — #52 is stacked on top of #51 (`main` ← #51 `strive-vnext-phaseB` ← #52 `strive-astra`), so its diff is only the Astra-specific delta. The commit history reads as the changelog: each milestone is scoped, independently described, and (per the PR body) independently green under the project's verify gates. This is well organized — no action needed beyond merging #51 before #52.

## The real complication: PRs #31–#35 (Parallax)

Unlike the strive stack, the five open Parallax PRs (#31 unslop, #32 consolidate, #33 gsm8k-live, #34 checkpoint-evolution, #35 simplify) all target `main` directly and are **not** stacked on each other — verified with `git merge-base --is-ancestor`, none is an ancestor of any other. Yet they heavily overlap in the files they touch (`RESEARCH-PROCESS.md`, `checkpoint_screening.py`, `provider.py`, `admission.py`, `screening.py`, `specs.py`, and more). All five were opened within a 20-minute window on 2026-08-04 and haven't been touched since — they're five divergent siblings from the same short research burst, now over five weeks stale.

PR #35's own description effectively diagnoses the problem: it describes a harness that had grown *competing* type systems per benchmark (a distinct `SweIntent`/`SweTurn` family for SWE-bench, a third one for checkpoint evolution) and 17 near-duplicate research scripts that reimplemented `report.py`'s scoring math with drifted thresholds. That's exactly the kind of drift produced by #31–#34 evolving the same modules in isolation rather than as a stack.

Meanwhile `main` hasn't stood still: it already has `canonical.py`, `outcome.py`, and `checkpoint_sandbox.py` under `parallax/src/parallax/`, none of which appear in any of #31–#35's diffs — this landed through separate, already-merged commits. So all five PRs are working against a base that `main` has since moved past, which is almost certainly why #33 now shows a genuine merge conflict (it touches `provider.py`, `runner.py`, `evolving_intent.py` — files `main` has independently changed).

## Recommended merge order

1. **#51** (`strive-vnext-phaseB` → `main`) — merge first; it's the actual dependency for #52.
2. **#52** (`strive-astra` → `strive-vnext-phaseB`, then effectively → `main`) — merge immediately after #51; no other work touches this code.
3. **Parallax #31–#35 — do not merge as an unordered batch.** They're mutually inconsistent snapshots of the same refactor, not independent changes:
   - Treat **#35 (parallax-simplify)** as the likely superseding design — it's the only one of the five that names and fixes the type-duplication problem the other four collectively caused, and it was the last of the five created.
   - Before merging #35, diff it against current `main` (not against its stale branch point) to confirm it doesn't regress the `canonical.py`/`outcome.py`/`checkpoint_sandbox.py` consolidation `main` already has — this needs a manual rebase/reconciliation, not a straight merge.
   - #31, #32, #33, #34 should be closed, or cherry-picked for anything uniquely valuable (e.g., #34's headroom-disambiguation retraction note, #33's live GSM8K evidence run) directly into whatever supersedes #35, rather than merged wholesale — merging them alongside #35 would reintroduce the exact drift #35 was written to remove.
   - #33 additionally needs a rebase regardless, since it's already flagged CONFLICTING against `main`.
4. **#23** (draft, "inspect background agent") is unrelated to both stacks; leave it as-is until its author decides it's ready for review — no ordering dependency on the above.

## Key findings
- PR #52's 22 commits = 1 commit per milestone (M1–M9) + docs/recap; the diff size reflects being stacked on #51, not bloat.
- PR #51 → #52 is a real, ordered dependency chain and must merge in that sequence.
- PRs #31–#35 (Parallax) are five divergent, un-stacked branches from one Aug 4 session, not independent work — merging them all would reintroduce type-system and scoring-logic drift.
- `main` has already progressed past the point where #31–#35 branched (see `canonical.py`, `outcome.py`, `checkpoint_sandbox.py`), which is the direct cause of #33's current merge conflict.
- #35 is the strongest candidate to keep; #31/#32/#33/#34 should be closed or cherry-picked from, not merged.
