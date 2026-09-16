# Parallax

Parallax is a research harness for identifying modern-agent failure modes,
turning them into research questions about agent training and RL environments,
synthesizing novel or harder but verifiable tasks from existing benchmarks and
codebases, and running controlled experiments with trustworthy evidence.

For a concrete start-to-finish picture — what you put in, what you run, and
what artifacts come out of each implemented flow — read
[`docs/PIPELINES.md`](docs/PIPELINES.md) first.

The package is organized around four concepts, not around benchmark times
method. Every flow is some configuration of these four:

1. **Task** (`task.py`). A task is public material an agent may read, sealed
   material that decides whether it succeeded, and the agent contract that says
   how a submission must be shaped. `Task` is a structural protocol, so a
   benchmark keeps its own natural problem model instead of inheriting fields it
   does not have. `gsm8k.py`, `swebench.py`, and `checkpoint_evolution.py` are
   adapters.
2. **Perturbation** (`perturbation.py`). A perturbation takes a task and
   produces a `VariantSet`: the conditions to compare it under, each a sequence
   of `Turn`s with an allowance split into `required_output` and `headroom`.
   Provenance is a field — `reference_based` derives its conditions from an
   existing benchmark task, `reference_free` synthesizes the family — because
   that distinction changes what a result means. `intent_evolution.py` and
   `intent_phases.py` are reference-based; `checkpoint_evolution.py` is
   reference-free.
3. **Experiment** (`experiment.py`). One loop: plan, admit, execute, resume,
   meter spend, journal evidence. Config in, evidence out. A plan preregisters
   its own digest, and the append-fsync journal makes a resumed run replay
   rather than re-pay. `admission.py` holds the two gates that discriminate a
   real verifier from a broken one: gold passes, no-op fails.
4. **Findings** (`findings.py`). One analysis path: journal in, findings out,
   plus a summary a human can read in ten seconds. `python -m parallax.findings
   JOURNAL` is the whole interface.

Conditions belong to an experiment, not to the type system. A perturbation may
declare a control condition; an experiment opts into it when its sample can
support the attribution. A 1,296-episode GSM8K round is why that option exists:
evolved scored 0.109 below single-turn base, and only the presence of a
presentation-matched control split that into 0.086 from multi-turn presentation
and 0.023 from intent evolution on top. Two conditions would have credited the
whole drop to the manipulation.

All JSON boundaries parse into strict frozen Pydantic models with unknown fields
forbidden. Plan and observation records use a `kind` discriminator, as do
outcomes. Canonical JSONL uses sorted keys, compact separators, and
non-finite-number rejection; identical inputs therefore remain byte-stable.

Sealed material never enters construction prompts or turn text. A benchmark
declares its submission contract next to its verifier, and the only accessor
that yields agent-facing text is `VariantSet.prompts`, which cannot be called
without that contract — so the grader and the instructions cannot come apart.
For GSM8K the contract is a final `FINAL_ANSWER: <integer>` line with exactly
one marker and a canonical integer. Malformed submissions are invalid, valid
non-matching answers are wrong, and provider, budget, and verifier faults are
run failures.

Trials are samples, not replicates. The gateway accepts a `seed` and ignores it,
verified empirically, so nothing in the plan pretends a trial can be reproduced;
temperature is causally real and is what the design pins.

The offline tests use small real-shaped rows and scripted providers. They
exercise construction, every condition including the control, history-sensitive
execution, grading, journal round-trips, resume without double-paying, and the
paired bounds, all without network calls.

The SWE-bench Verified path adds the machinery a containerized benchmark needs,
all of it configuration of the same four concepts:

1. `provider.py` defines strict OpenAI-compatible request and response models.
   One direct HTTP client serves text-only construction calls and tool-call
   agent requests. Credentials come from a named environment variable and never
   enter serialized requests. Token pricing and the Markdown-fence tolerance
   every parser needs live here, once.
2. `swebench.py` pins the Verified dataset revision, keeps the gold patch under
   sealed authority, and separates the public issue from the official verifier.
3. `swebench_specs.py` freezes a task into a sealed `SweTaskSpec` and compiles
   the container bundle. Agent artifacts are built only from public material,
   the build context is scanned for sealed fragments, and every artifact digest
   is recorded.
4. `delivery.py` and `swebench_executor.py` push turns from the evaluation loop.
   Early submissions and exhausted step budgets deliver the next turn.
   `swebench_runtime.py` refuses to grade without a complete per-turn receipt,
   then exports a candidate patch that includes untracked files.
5. `swebench_harness.py` runs the pinned official SWE-bench harness
   evaluator-side against the digest-pinned official image. The harness verdict
   is authoritative; coverage is checked against the committed FAIL_TO_PASS and
   PASS_TO_PASS sets.

The preregistered HUD screening completed five SWE-bench instances with two
static Claude Opus 4.8 trials each. Both Django instances passed 2/2; Astropy,
Matplotlib, and Requests passed 0/2. At five sources the interval is far wider
than any effect worth measuring, so the run locates an operating point rather
than supporting a comparison. Known metered spend was $1.669650, with a
conservative $2.147440 all-in bound for unmetered construction failures under
the $5 cap. Candidate patches were graded from a pinned SWE-bench source
checkout after its wheel omitted a required harness fixture.

Screening round 2 found three Claude Opus 4.8 boundary instances at 2/3:
Astropy 14508, Django 13786, and Xarray 4695. Actual token-metered round-two
spend was $2.972512 under the $5 cap. These instances and model are the
recommended operating point for the first single-vs-evolved comparison.

The three boundary instances passed every admission gate under the official
harness. Their identity patches applied and failed, and their gold patches
passed on the first attempt. The first 18-unit static-versus-evolved design is
preregistered but has not run.

[`docs/MODEL.md`](docs/MODEL.md) defines the research vocabulary.
[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) records the
method contract, implementation choices, and evidence limits.

> **TODO:** Collect retained real-provider construction and run evidence before
> interpreting an empirical effect.
