# Parallax

Parallax is a research harness for identifying modern-agent failure modes,
turning them into research questions about agent training and RL environments,
synthesizing novel or harder but verifiable tasks from existing benchmarks and
codebases, and running controlled experiments with trustworthy evidence.

For a concrete start-to-finish picture — what you put in, what you run, and
what artifacts come out of each implemented flow — read
[`docs/PIPELINES.md`](docs/PIPELINES.md) first.

The executable slice follows one complete path:

1. `gsm8k.py` loads real-shaped GSM8K JSONL and retains the canonical
   `#### <integer>` answer as a branded, sealed grading authority.
2. `evolving_intent.py` asks a synchronous `Chat` callable for strict JSON
   construction outputs and builds frozen static, matched, and evolved scripts.
   Reveal, revise, and switch events use an explicit `kind` discriminator.
   Static renders the fully revealed extracted intent rather than the source
   question. The
   matched intervention is a turn-count-and-budget-matched progressive source
   reveal.
3. `runner.py` preregisters source-trial units and identity digests, executes
   every scheduled arm, and writes deterministic JSONL through atomic
   replacement. Construction attempts and scripts appear once per source.
4. `report.py` validates every scheduled row before aggregation. It reports
   source-clustered matched-versus-evolved identification bounds, a closed-form
   95% Hoeffding interval, and an `advance`, `reject`, or `inconclusive` action.

All JSON boundaries parse into strict frozen Pydantic models with unknown fields
forbidden. Manifest, family, and run records use a `kind` discriminator, as do
events and outcomes. Canonical JSONL still uses sorted keys, compact separators,
and non-finite-number rejection; identical inputs therefore remain byte-stable.
The report consumes these typed records and reserves its own checks for
relationships across records, such as missing scheduled rows or identity drift.

`Problem.answer` never enters construction prompts or public turn text. The
native grader accepts one submission policy: the final non-empty line must be
`FINAL_ANSWER: <integer>`, with exactly one marker and a canonical integer.
Malformed submissions are invalid. Valid non-matching answers are wrong.
Provider, budget, and verifier faults are run failures.

The offline tests use small real-shaped GSM8K rows and scripted `Chat`
implementations. They exercise construction, all three arms, history-sensitive
execution, grading, manifest validation, JSONL round-trips, missing-outcome
bounds, and source-clustered reporting without network calls. Parallax has no
real-provider evidence, generated benchmark pool, or paper-score reproduction.

The second slice adds an offline-ready SWE-bench Verified path:

1. `provider.py` defines strict OpenAI-compatible request and response models.
   One direct HTTP client serves text-only construction calls and tool-call
   agent requests. Credentials come from a named environment variable and
   never enter serialized requests. Response-side models tolerate unconsumed
   provider fields while validating every field Parallax reads.
2. `swebench.py` pins the Verified dataset revision and the paper's 50
   published evaluation IDs. It keeps the gold patch under sealed authority,
   separates the public issue from the official verifier, builds budget-equal
   arms, and records the pinned SWE symptom-overlay transformation.
3. `specs.py` freezes each family into versioned `TaskSpecV1` and `EnvSpecV1`
   models. `hud_compile.py` creates agent artifacts only from `PublicTaskV1`.
   It tags every output by audience, scans the agent build context for sealed
   fragments, and records artifact digests.
4. `delivery.py` and `hud_screening.py` push scripted turns from the evaluation
   loop. Early submissions and phase-budget exhaustion deliver the next turn.
   `swebench_runtime.py` rejects grading without a complete per-phase receipt,
   then exports a candidate patch that includes untracked files.
5. `swebench_harness.py` runs the pinned official SWE-bench harness
   evaluator-side against the digest-pinned official image. The harness verdict
   is authoritative; report coverage is checked against the committed
   FAIL_TO_PASS and PASS_TO_PASS sets.
6. `screening.py` preregisters boundary-model screening units and canonical
   outcomes before execution, appends and fsyncs each unit to a resumable
   partial file, records provider model/usage and estimated cost, refuses to
   overwrite completed evidence, defaults to a $5 upper cap, and withholds a
   decision while the design's minimum-detectable-effect is too large.
7. `admission.py` runs schema, sealed-leakage, identity-patch, gold-patch,
   budget-match, and arm-completeness gates before new scheduling code accepts
   a family.

The preregistered HUD screening completed five SWE-bench instances with two
static Claude Opus 4.8 trials each. Both Django instances passed 2/2; Astropy,
Matplotlib, and Requests passed 0/2. The design is underpowered and makes no
advance/reject decision. Known metered spend was $1.669650, with a conservative
$2.147440 all-in bound for unmetered construction failures under the $5 cap.
Candidate patches were graded from a pinned SWE-bench source checkout after its
wheel omitted a required harness fixture.

Screening round 2 found three Claude Opus 4.8 boundary instances at 2/3:
Astropy 14508, Django 13786, and Xarray 4695. Actual token-metered round-two
spend was $2.972512 under the $5 cap. These instances and model are the
recommended operating point for the first single-vs-evolved comparison; the
small-run power rule still withholds any advance/reject decision.

The three boundary instances passed every admission gate under the official
harness. Their identity patches applied and failed, and their gold patches
passed on the first attempt. The first 18-unit static-versus-evolved design is
preregistered but has not run.

[`docs/MODEL.md`](docs/MODEL.md) defines the research vocabulary.
[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) records the
method contract, implementation choices, and evidence limits.

> **TODO:** Collect retained real-provider construction and run evidence before
> interpreting an empirical effect.
