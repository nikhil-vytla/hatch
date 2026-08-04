# Parallax

Parallax is a research harness for turning observed agent failure modes into
controlled experiments. It synthesizes harder but still verifiable tasks from
existing benchmarks, runs matched arms against them, and refuses to report an
effect its design cannot identify.

Three documents cover most of what you want:

- [`docs/FINDINGS.md`](docs/FINDINGS.md) lists every run to date, what it asked,
  what it returned, and what it cost. Start here if you want results.
- [`docs/PIPELINES.md`](docs/PIPELINES.md) walks each implemented flow from input
  to command to output artifact. Start here if you want to run something.
- [`docs/MODEL.md`](docs/MODEL.md) defines the vocabulary the other two use.

## What is implemented

The GSM8K path is offline, deterministic, and complete:

1. `gsm8k.py` loads real-shaped GSM8K JSONL and keeps the canonical
   `#### <integer>` answer as a branded, sealed grading authority.
2. `evolving_intent.py` asks a synchronous `Chat` callable for strict JSON and
   builds frozen static, matched, and evolved scripts. Reveal, revise, and switch
   events carry an explicit `kind` discriminator. Static renders the fully
   revealed extracted intent, never the source question, so rendering style
   cannot confound the comparison. The matched arm is a progressive source reveal
   matched to evolved on turn count and budget.
3. `runner.py` preregisters source-trial units and identity digests, executes
   every scheduled arm, and writes deterministic JSONL through atomic
   replacement.
4. `report.py` validates every scheduled row before aggregating. It reports
   source-clustered matched-versus-evolved bounds, a closed-form 95% Hoeffding
   interval, and an `advance`, `reject`, or `inconclusive` action.

The SWE-bench Verified path runs against a real provider and the official
harness:

1. `provider.py` defines strict OpenAI-compatible request and response models.
   One HTTP client serves both text construction calls and tool-call agent
   requests. Credentials come from a named environment variable and never enter
   serialized requests.
2. `swebench.py` pins the Verified dataset revision and the paper's 50 published
   evaluation IDs. It keeps the gold patch under sealed authority, separates the
   public issue from the official verifier, builds budget-equal arms, and records
   the pinned SWE symptom-overlay transformation.
3. `specs.py` freezes each family into versioned `TaskSpecV1` and `EnvSpecV1`.
   `hud_compile.py` builds agent artifacts only from `PublicTaskV1`, tags every
   output by audience, scans the agent build context for sealed fragments, and
   records artifact digests.
4. `delivery.py` and `hud_screening.py` push scripted turns from the evaluation
   loop. The agent has no turn-control tool. Early submissions and phase-budget
   exhaustion both deliver the next turn. `swebench_runtime.py` refuses to grade
   without a complete per-phase receipt, then exports a candidate patch including
   untracked files.
5. `swebench_harness.py` runs the pinned official SWE-bench harness
   evaluator-side against the digest-pinned official image. The harness verdict
   is authoritative; report coverage is checked against the committed
   FAIL_TO_PASS and PASS_TO_PASS sets.
6. `screening.py` preregisters units and canonical outcomes before execution,
   appends and fsyncs each unit to a resumable partial file, records provider
   model, usage, and estimated cost, refuses to overwrite completed evidence, and
   defaults to a $5 cap.
7. `admission.py` runs schema, sealed-leakage, identity-patch, gold-patch,
   budget-match, and arm-completeness gates before a family can be scheduled.

## What the evidence supports

All JSON boundaries parse into strict frozen Pydantic models with unknown fields
forbidden. Manifest, family, and run records use a `kind` discriminator, as do
events and outcomes. Canonical JSONL uses sorted keys, compact separators, and
non-finite-number rejection, so identical inputs produce identical bytes.

`Problem.answer` never enters construction prompts or public turn text. The
native GSM8K grader accepts one submission policy: the final non-empty line must
be `FINAL_ANSWER: <integer>`, with exactly one marker and a canonical integer.
Malformed submissions are invalid, valid non-matching answers are wrong, and
provider, budget, or verifier faults are run failures rather than model behavior.

Two SWE-bench screening rounds and one 18-unit static-versus-evolved experiment
have run against Claude Opus 4.8. Metered spend across them is $5.86. The
experiment's paired delta is +0.111 with a 95% interval of [-1, 1], because three
source clusters give a minimum detectable effect of 1.568 against an estimand
bounded in [-1, 1]. [`docs/FINDINGS.md`](docs/FINDINGS.md) has the per-instance
numbers and the two design gaps that matter.

GSM8K has never called a real provider. Its evidence is scripted agents against
real-shaped rows, exercising construction, all three arms, history-sensitive
execution, grading, manifest validation, JSONL round-trips, missing-outcome
bounds, and source-clustered reporting. Parallax has no generated benchmark pool
and reproduces no paper score.

[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) records the
method contract, the implementation choices, and every deliberate divergence from
the consulted upstream implementation.

> **TODO:** Run the matched arm on SWE-bench, or run GSM8K against a real
> provider. Until one of those happens, no implemented flow has both a complete
> design and real-model evidence.
