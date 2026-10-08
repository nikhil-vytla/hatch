# Round 2 notes

## Preregistered design

- Goal: find at least three boundary instances whose static pass rate is
  strictly between zero and one.
- Population: the paper's 50 published SWE-bench Verified IDs at pinned dataset
  revision `91aa3ed51b709be6457e12d00300a6a596d4c6a3`.
- Public stratification signal: the pinned `difficulty` annotation has 28
  `<15 min fix`, 20 `15 min - 1 hour`, one `1-4 hours`, and one `>4 hours`
  instance.
- Sampling rule: exclude the round 1 IDs, retain the 19 untested
  `15 min - 1 hour` IDs, group by repository prefix, choose six repository
  groups without replacement with seed `20260803`, then choose one instance
  from each selected group with the same RNG.
- Selected IDs: `matplotlib__matplotlib-22871`,
  `mwaskom__seaborn-3069`, `pydata__xarray-6721`,
  `pylint-dev__pylint-7080`, `sympy__sympy-13091`, and
  `astropy__astropy-14508`.
- Model: `claude-opus-4-8`. Round 1 proved this model spans floor and ceiling.
  Moving to Sonnet while moving to harder tasks would combine two difficulty
  shifts and risks another floor-heavy screen. Opus 5 would shift toward
  ceilings and cost more.
- Trials: three static trials per instance with seeds `2026080301`,
  `2026080302`, and `2026080303`. Boundary means exactly 1/3 or 2/3 passes.
- Spend: fresh \$5 cap. The preregistered upper reserve is \$0.25 per episode,
  or \$4.50 for 18 episodes, leaving \$0.50 for Haiku construction. Round 1's
  observed Opus episode mean was about \$0.153, so expected total spend is
  approximately \$2.9 including construction.
- Stop rules: stop on HUD authentication failure, observed cost above \$5, or
  when the next episode's reserved upper bound could exceed the cap.
- Grading: evaluator-side official SWE-bench harness from detached pinned
  source revision `f7bbbb2ccdf479001d6467c9e34af59e44a840f9`.
- Evidence: write the canonical screening manifest before the first paid
  construction call, then fsync every construction and episode receipt.

## Preregistered tier-down extension

- The first six-instance screen cost \$2.926905 and found one boundary:
  `astropy__astropy-14508` at 2/3. Matplotlib, Seaborn, Pylint, and SymPy were
  floors; Xarray was a ceiling.
- Goal: find at least two additional boundaries without exceeding the same
  round-two \$5 cap.
- Selection rule: take the three observed Opus 4.8 ceilings available across
  rounds 1 and 2. They are `django__django-10914`,
  `django__django-13089`, and `pydata__xarray-6721`.
- Model: `claude-sonnet-4-6`, one tier below the established ceiling model.
  This changes only model capacity on tasks already known to be solvable at
  Opus 4.8.
- Trials: three static trials per instance with seeds `2026080311`,
  `2026080312`, and `2026080313`. Boundary means 1/3 or 2/3 passes.
- Spend: no construction calls. The extension reserves \$0.20 per episode, or
  \$1.80 total. With \$2.926905 already spent, the aggregate reserve is
  \$4.726905.
- Pricing evidence: Anthropic's current introductory Sonnet 4.6 rate is \$2 per
  million input tokens and \$10 per million output tokens through August 31,
  2026. The \$0.20 per-episode reserve remains substantially above observed
  episode costs.
- Stop rules and official grading are unchanged.

## Preregistered remaining-medium extension

- Cost audit: the first screen's receipts used the retired Opus 4.1 rate for
  Opus 4.8 and Haiku construction. Repricing actual token usage at current
  model-specific rates gives \$0.881655 for the first screen. The Sonnet
  extension cost \$0.106100. Cumulative actual spend is \$0.987755.
- The Sonnet extension produced two ceilings and one floor, with no new
  boundary. The same-model goal therefore still has only the Opus 4.8 boundary
  `astropy__astropy-14508`.
- Population: all 13 untested `15 min - 1 hour` instances remaining after the
  round-one and first round-two screens. No outcome-based selection is used.
- Selected IDs: `astropy__astropy-8707`, `django__django-12143`,
  `django__django-13343`, `django__django-13658`,
  `django__django-13786`, `matplotlib__matplotlib-14623`,
  `pydata__xarray-4695`, `pylint-dev__pylint-6528`,
  `scikit-learn__scikit-learn-12973`,
  `scikit-learn__scikit-learn-14087`,
  `scikit-learn__scikit-learn-14894`, `sphinx-doc__sphinx-10466`, and
  `sympy__sympy-15599`.
- Model: `claude-opus-4-8`, matching the boundary already found.
- Trials: two static trials per instance with seeds `2026080321` and
  `2026080322`. Boundary means exactly 1/2 passes.
- Spend: \$4.012245 remains under the round-two cap. The extension reserves
  \$0.12 per episode, or \$3.12 for 26 episodes, leaving \$0.892245 for Haiku
  construction. Current rates are \$5/\$25 per million Opus input/output tokens
  and \$1/\$5 per million Haiku input/output tokens.
- Stop rules and official grading are unchanged.

## Preregistered third-trial extension

- The remaining-medium extension cost \$1.362807 including construction.
  Cumulative actual round-two spend is \$2.350562.
- All 13 instances were still bimodal at two trials: eight ceilings and five
  floors. No additional Opus 4.8 boundary was found.
- Population: the same 13 remaining-medium instances. Add one trial uniformly
  to every instance rather than selecting by observed outcome.
- Model: `claude-opus-4-8`.
- Trial seed: `2026080323`. Combined classification uses the original two
  trials plus this third trial. Boundary means 1/3 or 2/3 passes.
- Spend: \$2.649438 remains. The extension reserves \$0.12 per episode, or \$1.56
  total, with no construction calls.
- Stop rules and official grading are unchanged.

## Results

- Opus 4.8 boundaries: `astropy__astropy-14508`,
  `django__django-13786`, and `pydata__xarray-4695`, each at 2/3.
- Initial six-instance Opus screen: Astropy 14508 was 2/3; Xarray 6721
  was 3/3; Matplotlib 22871, Seaborn 3069, Pylint 7080, and SymPy 13091
  were 0/3.
- Sonnet 4.6 tier-down: Django 10914 and Django 13089 remained 3/3;
  Xarray 6721 moved to 0/3. It found no boundary.
- Remaining-medium Opus screen after three trials: Django 13786 and Xarray
  4695 were 2/3. Django 12143, Django 13343, Django 13658, Scikit-learn
  12973, Scikit-learn 14894, and Sphinx 10466 were 3/3. Astropy 8707,
  Matplotlib 14623, Pylint 6528, Scikit-learn 14087, and SymPy 15599 were
  0/3.
- Actual token-metered spend: \$2.972512. The canonical component breakdown is
  in `round2-report.json`.
- Recommendation: run the first real single-vs-evolved contrast on the three
  Opus 4.8 boundary instances. At three source clusters it estimates direction
  and uncertainty, and that is the whole of what it can do.

## Operational findings

- The byte-scan backstop initially rejected Pylint 7080 and SymPy 13091 because
  official test identifiers occurred naturally in public task text. Derived
  fragments now ignore overlap already present in the typed public branch; the
  full sealed test patch remains mandatory to scan.
- The same public-overlap issue existed in `SweScript` validation for SymPy
  15599. Exact test identifiers already in the public problem statement are
  now allowed; full test-patch leakage remains forbidden.
- Docker Desktop exhausted the host disk while pulling the Scikit-learn image.
  The partial journal retained 18 completed units. Pruning 5 GiB of reusable
  uv cache and 14.06 GB of Docker build cache restored the daemon, after which
  the eight zero-cost failures resumed.
- The Hugging Face filter API returned HTTP 500 and then timed out during
  resume. The fallback reads the immutable 2 MB parquet at the pinned dataset
  revision and verifies SHA-256
  `43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21`.
- HUD 0.6.12 repeatedly logged non-fatal async client cleanup warnings after
  episodes. All canonical receipts and official-harness reports completed.
- The old Opus price constant was the retired Opus 4.1 rate. Round-two cost was
  recalculated from retained tokens at current model-specific rates and the
  runtime constants were corrected.
