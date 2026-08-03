# Working notes: coding-benchmark selection for Parallax

Scope per steer: decide between the two coding-adjacent benchmarks the
Evolving Intent paper itself covers — SWE-bench Verified and BIRD-SQL.
LiveCodeBench/BigCodeBench-style candidates are excluded because the upstream
Evolving Intent pipeline has no construction support for them (they are outside
the paper's four domains). Slop-code-bench stays reserved for the
checkpoint-evolution second method, not this pick.

## What I read

- `parallax/docs/MODEL.md` and `parallax/docs/methods/evolving-intent.md` on
  `main` for the grading model: sealed verifier authority `V*` must be
  identical across static/matched/evolved arms; pairing is per-source matched
  contrast.
- PR #11 (`cursor/parallax-evolving-intent-slice`) interfaces only:
  `RunIdentity(design_digest, source_id, source_digest, model_config_digest,
  trial_index, trial_seed, arm, arm_config_digest)`; runner iterates
  `ARMS = (static, matched, evolved)`; report consumes run JSONL keyed on
  `(source_id, trial_index)` units. Did not touch that worktree.
- `architecture/evolving-intent-pipeline/` characterization corpus:
  - `characterization/UPSTREAM-SWE-OVERLAY.md`: SWE turn-scheduler overlay at
    pinned upstream commit `993d6be` is a narrow correction (strip
    symptom-category arguments before generic scheduling, re-inject them at
    slot front before text construction). Understood and hash-pinned.
  - `README.md` + `arena/candidate-D.md` on BIRD-SQL: construction uses global
    shuffling, multiple workers, and completion-order collection, so a seed
    alone does not define output order; predecessor chains are clause-plan
    driven with six validators including live DB execution; per-turn gold
    needs AST surgery (`sql_partial.py`) plus live DB execution; the pinned
    BIRD database tree and evidence files are NOT in the Microsoft repo and
    retention/redistribution terms are unresolved (also flagged in
    `FORMAL-MODEL.md` and `LITERATURE-REVIEW.md`).
  - `LITERATURE-REVIEW.md`: the paper fixes published evaluation IDs for 50
    SWE-bench Verified records (and 100 BIRD-SQL).
- `architecture/episode-spine/`: README implementation status, calibration
  JSONs, `swebench-environment/` (Dockerfile.hud, env.py), spike tests.

## Saturation evidence (web, 2026-08-02)

- SWE-bench Verified: Claude Opus 5 96% (BenchLM, Aug 2 2026); Vals AI
  independent harness: Opus 5 97.0%, GPT-5.6 Sol 96.2%, Claude Fable 5 95.0%,
  Kimi K3 93.4%, Claude Opus 4.8 88.6%. Top tier clustered within ~1 pt —
  near-saturated at the absolute frontier, mid-tier still 80–89%.
- BIRD-SQL: human baseline 92.96% EX; best single model Gemini-SQL2 80.04%
  test EX (June 2026); best overall leaderboard entries ~82% (AskData+GPT-4o
  81.95%). Nominally ~13 pts of headroom, BUT audits found annotation errors
  in over half of examined BIRD examples, and ReViSQL reaches 93.78% EX
  (above the human proxy) on expert-corrected subsets (arXiv:2603.20004).
  Much of BIRD's apparent headroom is label noise — which is fatal for a
  sealed-verifier design, since the verifier would be authoritatively wrong on
  a large fraction of sources.

## Spike-asset verification (non-destructive)

- Docker daemon 24.0.6 up. Local images present:
  `parallax-swebench-django-11099:local` (3.03 GB), two cached
  `sweb.env.py.x86_64.*` bases, `sweb.base.py.x86_64`.
- `env.py` imports inside the image (`docker run --rm --entrypoint python …
  import env` → `django__django-11099`, arms static/matched/evolved). ~13 s
  under amd64 emulation.
- Host side: `hard-repo-tasks/pyproject.toml` does NOT carry hud; the
  environment-local `swebench-environment/pyproject.toml` pins `hud==0.6.12`.
  With `uv run --with pytest --with mini-swe-agent` both spike tests collect
  (`test_gold_fix_passes_all_intent_arms`, `test_no_op_fails_official_verifier`).
  Gotcha: the PyPI name is `mini-swe-agent`, import name `minisweagent`.
- Ran `test_no_op_fails_official_verifier` end-to-end in the background
  (full path: container boot, turn director, workspace reset, sealed test
  patch application, official verifier command). Result recorded in README.
- Verified official per-instance eval images are on Docker Hub:
  `docker manifest inspect swebench/sweb.eval.x86_64.django_1776_django-11099`
  and `…astropy_1776_astropy-12907` both resolve (naming: `__` → `_1776_`).
  This closes the episode-spine README's "private cached sweb.env image"
  reproducibility gap without any local builds.

## Cost anchors from prior receipts

- `swebench-proof.json`: full official harness (build + run) for one instance,
  gold prediction: 846.9 s, 3 FAIL_TO_PASS + 19 PASS_TO_PASS.
- In-env grading (focused test module inside a warm container) is minutes, not
  the full 14; the calibration smoke ran 6 episodes (2 models × 3 arms).
- Known confound recorded in `swebench-calibration-summary.json`: static arm
  had 12 agent steps total while matched/evolved had 12 per turn — arms were
  not budget-equivalent. Must be fixed in the slice design.

## Decision reasoning (short)

Every axis except nominal saturation points at SWE-bench Verified: coding
preference (repo-level editing vs text-to-SQL), assets (working HUD env vs
nothing), verifier sealing (pinned test harness with content-addressed
commitments vs execution-match needing an unavailable DB tree and noisy gold),
upstream fidelity (characterized narrow overlay vs seed-independent ordering
nondeterminism). On saturation, BIRD's larger headroom is substantially
annotation noise; and Parallax's estimand is the paired matched-vs-evolved
degradation at a non-saturated operating point, which we control via model and
instance selection — not the absolute frontier pass rate.
