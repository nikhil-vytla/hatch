# SWE-bench screening round 2

Round 2 found three static boundary instances for Claude Opus 4.8 under the
official SWE-bench harness. `astropy__astropy-14508`,
`django__django-13786`, and `pydata__xarray-4695` each passed 2/3 trials.
They are the recommended instance set and model for the first real
single-vs-evolved comparison.

## Design

The first screen sampled six repository-stratified instances from the pinned
`15 min - 1 hour` difficulty stratum and ran three Opus 4.8 trials each. A
preregistered Sonnet 4.6 tier-down tested three known Opus ceilings. The final
Opus census covered every remaining untested medium-difficulty instance with
two trials, then added one uniform third trial to all 13.

Every manifest was canonical and fsynced before paid execution. Every episode
recorded the provider-reported model and token usage. Candidate patches were
graded evaluator-side with official SWE-bench revision
`f7bbbb2ccdf479001d6467c9e34af59e44a840f9` and digest-pinned official images.
These small screens remain underpowered and make no advance/reject claim.

## Outcomes

Opus 4.8:

- Boundary at 2/3: Astropy 14508, Django 13786, Xarray 4695.
- Ceiling at 3/3: Xarray 6721, Django 12143, Django 13343, Django 13658,
  Scikit-learn 12973, Scikit-learn 14894, Sphinx 10466.
- Floor at 0/3: Matplotlib 22871, Seaborn 3069, Pylint 7080, SymPy 13091,
  Astropy 8707, Matplotlib 14623, Pylint 6528, Scikit-learn 14087,
  SymPy 15599.

Sonnet 4.6:

- Ceiling at 3/3: Django 10914 and Django 13089.
- Floor at 0/3: Xarray 6721.
- No boundary.

## Spend

Actual token-metered spend was $2.972512 against the $5 cap:

- Initial construction: $0.023495.
- Initial Opus screen: $0.858160.
- Sonnet tier-down: $0.106100.
- Remaining construction: $0.027712.
- Remaining first two Opus trials: $1.335095.
- Uniform third Opus trials: $0.621950.

The original runtime priced Opus 4.8 with the retired Opus 4.1 rate and priced
Haiku construction as Opus. The retained usage was recalculated at current
model-specific rates. Runtime pricing constants now use $5/$25 per million
Opus input/output tokens and $1/$5 for Haiku. Sonnet 4.6 used its current
introductory $2/$10 rate.

The `estimated_cost_usd` fields inside `evidence/screening.jsonl` and
`evidence/construction.jsonl` still hold the retired-rate values they were
written with, so summing receipts across this folder's evidence gives
$8.544627 — nearly three times the truth. $2.972512 is the token-derived
figure and the one to quote; `research/spend-audit-20260803/` recomputes it
from the retained tokens and reconciles it against these six components.

## Evidence

- `round2-report.json` is the canonical combined result and cost receipt.
- `evidence/screening.jsonl` contains the first Opus screen.
- `evidence/tier-down-screening.jsonl` contains the Sonnet tier-down.
- `evidence/remaining-medium-screening.jsonl` contains the first two census
  trials.
- `evidence/remaining-medium-third-trial.jsonl` contains the uniform third
  trials.
- `evidence/*failure*.jsonl` preserves zero-cost byte-scan and Docker failure
  attempts.
- `NOTES.md` records every design before its paid run and the operational
  recovery trail.

## Operational findings

Public task text can legitimately contain official test identifiers. The
sealed-byte scanner now excludes derived fragments already present in the
typed public branch while always scanning the full sealed patch. The source
script validator applies the same public-overlap rule.

Docker Desktop exhausted host storage during a large Scikit-learn pull.
Incremental evidence preserved 18 completed units. After pruning reusable uv
and Docker build cache, the remaining eight units resumed without repeated
inference. When the Hugging Face filter API returned 500 and timed out, the
resume path used the immutable pinned parquet with a verified SHA-256 digest.

## Verification

- Normal tests: 124 passed.
- Optimized tests: 124 passed under `PYTHONOPTIMIZE=1`.
- Mutation gates: the scores originally reported here came from gauntlets
  that were never committed. The reproducible gauntlet is
  `tests/test_mutation_gauntlet.py` (`pytest -m mutation`).
- Ruff: passed for `src`, `tests`, and both screening research directories.
- `ty`: passed for `src`.
- Package build: source distribution and wheel succeeded.
- Evidence synthesis: canonical report digest
  `2a82ce5970ff34968a0ba36acf8e02fa11a304b9ae7bb218044955e8d8027276`.
