# Coding-benchmark selection: SWE-bench Verified + Evolving Intent

**Decision: SWE-bench Verified is the next Parallax benchmark, run under the
Evolving Intent synthesis method.** BIRD-SQL is rejected for this slice.
LiveCodeBench/BigCodeBench-style candidates were excluded up front because the
Evolving Intent upstream has no construction support for them (they are outside
the paper's covered domains). Slop-code-bench (SprocketLab,
[arXiv:2603.24755](https://arxiv.org/abs/2603.24755)) remains the planned
substrate for the *second* synthesis method (checkpoint evolution), not this
pick.

## Comparison

| Criterion | SWE-bench Verified | BIRD-SQL |
|---|---|---|
| Coding focus | Repository-level code editing — direct hit on the stated preference | Text-to-SQL; adjacent but not code editing |
| Frontier saturation (Aug 2026) | Top models 95–97% ([Vals AI](https://vals.ai/benchmarks/swebench): Claude Opus 5 97.0%, GPT-5.6 Sol 96.2%, Fable 5 95.0%; [BenchLM](https://benchlm.ai/benchmarks/swe-bench-verified): Opus 5 96%). Near ceiling at the absolute frontier; mid-tier models sit at 80–89% | Best single model 80.04% test EX (Gemini-SQL2, Jun 2026) vs 92.96% human baseline ([BIRD leaderboard](https://bird-bench.github.io/)). Nominally more headroom — but audits found annotation errors in >half of examined examples, and [ReViSQL](https://arxiv.org/abs/2603.20004) scores 93.78% on expert-corrected subsets, so much of the gap is label noise |
| Verifier sealing | Official harness: reset to `base_commit`, discard agent test edits, apply sealed `test_patch`, run pinned per-instance command; verdict = FAIL_TO_PASS + PASS_TO_PASS all green. Commitment digests: harness revision, image digest, test-patch digest, F2P/P2P digests. Already proven in our env (gold passes, no-op fails) | Execution-set equality against gold SQL on a pinned DB snapshot. Requires the BIRD database tree + external-knowledge evidence, which are **not** in the upstream repo and have unresolved redistribution terms; per-turn gold needs AST surgery plus live DB execution; noisy gold labels directly corrupt sealed verdict authority |
| Upstream Evolving Intent fidelity | SWE turn-scheduler overlay characterized at pinned commit `993d6be` ([`UPSTREAM-SWE-OVERLAY.md` on the archive branch](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/characterization/UPSTREAM-SWE-OVERLAY.md)); the correction is narrow and hash-pinned | Construction uses global shuffling, multi-worker completion-order collection — a seed alone does not define output order; clause-plan predecessor chains need six validators including live DB execution |
| Existing assets | Working HUD env for `django__django-11099` (image built, Docker episode passed, hosted HUD run worked, official-harness proof, 6-run calibration smoke) | None |
| Time to first real experiment | Generalize an existing, verified environment to 10–20 instances | Acquire DB assets, build ingestion + verifier + environment from scratch |

On saturation, the honest read: SWE-bench Verified is itself near-saturated for
the top two or three frontier models. That matters less than it appears,
because Parallax's estimand is the *paired matched-vs-evolved degradation* at a
non-saturated operating point — we choose agent models and instances near their
decision boundary (the episode-spine calibration already showed GPT-5.6 Sol at
ceiling and Qwen3-8B at floor on the easy canary; both are wrong operating
points). BIRD's numerically larger headroom is substantially annotation error,
which is worse than saturation for us: a sealed verifier that is wrong on a
large fraction of sources invalidates the contrast, not just shrinks it.

## Slice plan

### Data ingestion

- Source: HuggingFace `SWE-bench/SWE-bench_Verified`, pinned to a dataset
  revision (same pattern as the Lite pin `69611d31…` in `swebench-proof.json`).
- Instance subset: intersect the Evolving Intent paper's 50 published
  SWE-bench Verified evaluation IDs (upstream `dataset_impl/swe_bench_verified`
  at `993d6be`) with instances whose official eval images exist on Docker Hub.
  Take 10–20 spanning difficulty, deliberately avoiding instances the
  boundary model passes or fails with probability near 0 or 1.

### Environment plan (decided: reuse the episode-spine HUD env)

One generated HUD environment per instance, exactly the
[`architecture/episode-spine/swebench-environment/`](https://github.com/nikhil-vytla/hatch/tree/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/episode-spine/swebench-environment) pattern (archive branch), with one change:
base the per-instance Dockerfile on the official published eval image
`swebench/sweb.eval.x86_64.<iid>` (naming: `__` → `_1776_`; verified pullable
for django-11099 and astropy-12907 on 2026-08-02) instead of the private
cached `sweb.env.*` base. Eval images ship `/testbed` at `base_commit`, so the
git-clone step in `Dockerfile.hud` disappears. This closes the episode-spine
README's named reproducibility gap. Rejected alternatives: plain local docker
through mini-swe-agent's own environment (spike fallback only — hides work
from HUD tracking); harness-only (no multi-turn intent director, so no
evolved arm).

### Arm mapping

- **static** — one terminal turn carrying the full source problem statement.
- **matched** — identical total agent-step and token budget, same number of
  user turns, zero intent evolution (upstream's no-change control). The
  hand-written filler in the current spike env is not upstream-faithful; the
  slice should use budget-matched no-change turns.
- **evolved** — predecessor chain toward the source intent with the overlay
  semantics characterized at `993d6be` (symptom-category arguments stripped
  before scheduling, re-injected at the front of the owning slot), terminal
  turn restores the exact source problem. Terminal-restoration invariant and
  identical verifier authority across all three arms, per
  `parallax/docs/MODEL.md`.

### Sealed verifier

Official SWE-bench harness semantics executed inside the environment at grade
time: reset to `base_commit`, keep only the agent's non-test edits, restore
authoritative test files, apply the official `test_patch`, run the pinned
per-instance test command; pass iff every FAIL_TO_PASS and PASS_TO_PASS test
passes. Sealed material (never agent-visible): `test_patch`, F2P/P2P lists,
harness revision, image digest. Verifier identity is committed as digests in
run records, matching the content-addressed commitments already sketched in
the evolving-intent-pipeline arena docs.

### Unit of pairing

`(source instance_id, trial_index/trial_seed)` across the three arms — the
same unit the PR #11 runner uses (`RunIdentity`); the paired contrast is
per-source matched-vs-evolved (and static-vs-evolved) verdict differences,
aggregated over trials with identification bounds.

### Expected cost/time per trial (estimates, to be calibrated)

Measured anchors: full official harness for one instance (build + run, gold)
took 846.9 s; in-env grading of a focused test module in a warm container is
1–4 min under amd64 emulation; container boot + import ~13 s. Per trial
(one source × three arms): roughly 15–30 min wall-clock locally on Apple
Silicon (emulated), a few minutes per arm on hosted HUD amd64. Model cost with
a mid-tier boundary agent at ≤12 steps/turn, ≤7 turns: order $0.10–0.50 per
arm. A 15-instance × 3-arm × 3-trial pilot ≈ 135 episodes ≈ $15–70 model
spend; a day serial locally, or a couple of hours with hosted HUD concurrency
(`max_concurrent≈4–8`).

## What changes to generalize from django-11099 to 10–20 instances

1. **Parameterize `env.py`**: `INSTANCE_ID`, `BASE_COMMIT`, `PROBLEM`,
   `TEST_PATCH`, the test command, and scope rules become per-instance data
   baked into the image as `instance.json`, not module constants.
2. **Replace the hand-curated `ALLOWED_PATHS` scope gate** with a
   dataset-derived rule (paths touched by the gold patch plus test paths), or
   drop the gate for the pilot and record edit scope as a metric — per-instance
   hand curation does not scale.
3. **Re-base `Dockerfile.hud`** on `swebench/sweb.eval.x86_64.<iid>` and
   template it per instance; delete the git fetch/checkout step.
4. **Per-instance test command**: derive from the SWE-bench harness spec
   (repo/version → command) rather than hard-coding the Django
   `runtests.py` invocation; verdict from the F2P/P2P lists.
5. **Replace the hand-authored `EPISODES` dict** with generated script
   families from the Parallax Evolving Intent construction (SWE overlay
   semantics). Interim pilot may use templated three-turn scripts, but the
   real experiment needs constructed predecessor chains — the current evolved
   turns are hand-written and not upstream-faithful.
6. **Fix the budget confound** recorded in
   `swebench-calibration-summary.json`: static got 12 agent steps total while
   multi-turn arms got 12 per turn. Define one total per-episode step budget,
   equal across arms.
7. **Instance/model selection for a live contrast**: pick a boundary model
   (mid-tier, 80–89% Verified class) and instances where its static-arm pass
   probability is neither ~0 nor ~1, using 1–2 screening trials per instance.
8. **Run-record compatibility**: emit runs keyed by the `RunIdentity` digest
   fields so the PR #11 report path can consume them once that slice lands
   (documented mapping only — no changes to `parallax/` source in this work).

## Spike-asset verification results (2026-08-02)

- Image `parallax-swebench-django-11099:local` (3.03 GB) present;
  `env.py` imports inside it and exposes all three arms.
- Both spike tests collect under
  `uv run --with pytest --with mini-swe-agent` from
  `swebench-environment/` (which pins `hud==0.6.12`). The root
  `hard-repo-tasks` environment on the archive-branch checkout does not
  include hud — use the environment-local project.
- `test_no_op_fails_official_verifier` executed end-to-end and **passed** in
  29 s (container boot, director MCP, workspace reset, mini-swe bridge,
  episode flow, grader scope gate — the no-op short-circuits at the scope
  gate before the sealed test patch is applied, so the full verifier command
  is covered by the gold-fix test, not this one). Transcript in
  `spike-verification.txt`. The longer `test_gold_fix_passes_all_intent_arms`
  (3 arms + full verifier runs) was not re-run; it last passed per the
  episode-spine README.
- Official per-instance eval images confirmed pullable from Docker Hub
  (django-11099, astropy-12907 probed via `docker manifest inspect`).

## Fastest path to a first real run

1. Pull official eval images for the chosen 10–20 paper-ID instances (no
   builds).
2. Template `env.py` + `Dockerfile.hud` per instance from `instance.json`
   (~1 day; the only new code is the template loader and the harness-spec
   test-command lookup).
3. Reuse the spike's mini-swe bridge and probe-agent pattern with a real model;
   run screening trials to pick boundary instances.
4. Run 15 × 3 × 3 with one boundary model on hosted HUD; grade in-env; pair
   per source; report matched-vs-evolved with the PR #11 report conventions.

## Main risk

**An indistinguishable contrast at the chosen operating point.** The
calibration smoke already showed the failure shape: the frontier model at
ceiling (3/3 arms) and the weak model at floor (0/3, invalid submissions), so
matched-vs-evolved differences were unmeasurable. Mitigation is built into the
plan — boundary-model selection, screening trials, per-instance difficulty
spread, equal budgets — but if Verified-class instances are too easy for every
model that can complete multi-turn repo edits at all, the effect may need
harder instance pools (SWE-bench full or Pro) sooner than planned. Secondary
risks: interim templated evolved turns are not upstream-faithful construction
(fine for the pilot, must be replaced before claims); amd64 emulation slowness
on Apple Silicon (mitigated by hosted HUD).
