# PR review notes

- Request: explain commit volume, review PR #52 organization, and recommend how to merge open PRs.
- Created this investigation folder as required by the workspace instructions. Review is read-only with respect to PRs, branches, and existing project files.

## Data gathered

Repo: `nikhil-vytla/hatch` (personal). Open PRs (`gh pr list --state open`):

| PR | title | base ← head | commits | mergeable |
|----|-------|-------------|---------|-----------|
| 52 | strive vNext clean-slate rebuild (Astra) | strive-vnext-phaseB ← strive-astra | 22 | MERGEABLE/CLEAN |
| 51 | Strive vNext Phase B: continual-refine@1 | main ← strive-vnext-phaseB | 31 | MERGEABLE/CLEAN |
| 35 | Restructure Parallax around task/perturbation/experiment/findings | main ← parallax-simplify | 1 | MERGEABLE/CLEAN |
| 34 | Checkpoint-evolution disambiguation | main ← parallax-checkpoint-evolution | 4 | MERGEABLE/CLEAN |
| 33 | Run GSM8K Evolving Intent against a real provider | main ← parallax-gsm8k-live | 1 | **CONFLICTING** |
| 32 | Consolidate Parallax | main ← parallax-consolidate | 10 | MERGEABLE/CLEAN |
| 31 | Unslop all Parallax prose + findings index | main ← parallax-unslop | 7 | MERGEABLE/CLEAN |
| 23 | Inspect background agent (draft) | main ← cursor/inspect-background-agent-8b0e | 22 | MERGEABLE/CLEAN (draft) |

### PR #52 shape
- 22 commits, each mapping 1:1 to a milestone (M1 substrate → M9 live tau2 campaign runner), plus a docs-fold commit and a session-recap commit. Stacked cleanly on #51 (`strive-vnext-phaseB`), not on `main` directly — so its diff (26,676 additions / 237 files) is *only* the Astra rebuild delta, not cumulative with #51.
- Commit granularity matches the PR body's own "What's here (M1–M8...)" breakdown — i.e. the commit history is the changelog. This is well organized: each commit is independently green (per the PR body's verify-gate claims) and reviewable in isolation.
- True dependency chain: `main` ← #51 (`strive-vnext-phaseB`) ← #52 (`strive-astra`). #52 cannot be merged to `main` correctly without #51 merging first (or retargeting).

### Parallax PRs (#31–#35) — the real complication
- All five target `main` directly (not stacked on each other). Checked ancestry: none of parallax-consolidate/gsm8k-live/checkpoint-evolution/unslop is an ancestor of parallax-simplify (`git merge-base --is-ancestor` → NO for all four). So despite heavy file overlap (all touch `parallax/docs/RESEARCH-PROCESS.md`; #32/#34/#35 all touch `checkpoint_screening.py`/`run_screening.py`; #32/#35 both touch `admission.py`, `conformance.py`, `delivery.py`, `provider.py`, `report.py`, `screening.py`, `specs.py`, `swebench*.py`), these are **divergent siblings**, not a stack.
- All five were created within ~20 minutes of each other on 2026-08-04 (06:17–06:38 UTC) and last-committed 2026-08-03/04 — over 5 weeks stale as of 2026-09-14.
- PR #35's own body diagnoses the problem directly: it says the old harness had competing type systems (`SweIntent`/`SweTurn` for SWE-bench, a third one for checkpoint evolution) and 17 near-duplicate research scripts reimplementing `report.py`'s math with **drifted thresholds**. That's a description of exactly the kind of drift you get from #31–#34 being separate, un-stacked branches touching the same modules.
- Checked `main`'s current `parallax/src/parallax/` tree: it already contains `canonical.py`, `outcome.py`, `checkpoint_sandbox.py` — none of which appear in any of #31/#32/#33/#34/#35's diffs. `git log` on those files shows they landed via other, already-merged commits (`e7b4ab9`, `0867c2c`) unrelated to these five PRs. So `main` has continued to evolve/consolidate parallax past the point where #31–#35 branched — these PRs are working against a stale base, which is almost certainly *why* #33 now shows CONFLICTING (it touches `provider.py`/`runner.py`/`evolving_intent.py`, which `main` has since changed).
- Verified PR #33's conflicting file list (`gh pr diff 33 --name-only`): the touched src files (`evolving_intent.py`, `provider.py`, `runner.py`) are exactly the ones `main` has since modified independently.
- #23 is an unrelated draft ("Inspect background agent from scratch") — separate feature, no file overlap investigated further since it's a draft and not part of the merge-ordering question.

## Learned
- git's own MERGEABLE/CLEAN check is only against current `main` tip; it says nothing about whether independently-authored sibling branches semantically conflict with each other once one of them lands. That's why the parallax PRs looked "clean" individually but are not safe to merge as an unordered batch.
- Investigation was read-only: no PRs, branches, or files outside this folder were modified.

## Follow-up: acting on the recommendation (2026-09-15/16)

- User merged PR #51 (`strive-vnext-phaseB` → `main`) via a real merge commit (`ca5ec92`), not squash/rebase.
- Asked to "update #52": retargeted its base from `strive-vnext-phaseB` to `main` via `gh pr edit 52 --base main`. Verified safety first — `strive-vnext-phaseB` was now an ancestor of `main`, and `strive-astra` was still exactly 22 commits ahead of both, so the retarget was metadata-only (no rebase/force-push, diff unchanged: 26,676 additions / 237 files).
- Hit a permissions error: the active `gh` account (`nikhil-at-canva`) has no write access to `nikhil-vytla/hatch`. A second logged-in account, `nikhil-vytla` (the repo owner), was available. Asked the user, then ran `gh auth switch --user nikhil-vytla`, did the retarget, and switched back to `nikhil-at-canva` afterward per the user's choice.
- PR #52 merged 2026-09-16 (`fd543a0`) directly into `main`. The strive stack (#51 → #52) is now fully landed; only the five stale Parallax PRs (#31–#35) and the unrelated draft (#23) remain open, per the original recommendation.
