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
   replacement. Construction attempts and scripts appear once per source.
4. `report.py` validates every scheduled row before aggregating, then reports the
   paired matched-versus-evolved difference, its identification bounds, a
   closed-form 95% source-clustered Hoeffding interval, and the minimum
   detectable effect. It states what the design resolved and stops there. No
   verdict.

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
   model, usage, and estimated cost, refuses to overwrite completed evidence,
   defaults to a \$5 cap, and reports the design's source-clustered interval and
   minimum detectable effect.
7. `admission.py` runs schema, sealed-leakage, identity-patch, gold-patch,
   budget-match, and arm-completeness gates before a family can be scheduled.

Checkpoint evolution, the second synthesis strategy, has a narrower slice: one
hand-verified three-checkpoint family, two arms, and one paid screening run.

1. `checkpoint_evolution.py` owns the workspace and checkpoint domain model, an
   entrypoint-only verifier that grades stage N against the accumulated
   obligations from stages 1 through N, and five executable admission gates.
   Dropping an inherited obligation is not constructible.
2. `checkpoint_runner.py` owns stage delivery. The agent is a pure function of
   public spec, carried workspace, and budget, with no advance channel. Run
   validators reject a skipped or reordered stage, a broken workspace-digest
   chain, and censoring that is not exactly the undelivered suffix.
3. `checkpoint_agent.py` renders a stage to the provider boundary and parses a
   strict JSON file map back. `checkpoint_sandbox.py` runs every sealed case in a
   digest-pinned container with no network and a read-only rootfs. The live
   screening path has no host-execution fallback.

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

Five runs have called a real provider, for \$6.14 of metered spend: two SWE-bench
screening rounds and an 18-unit static-versus-evolved experiment against Claude
Opus 4.8, plus a 60-call checkpoint-evolution screening against Claude Haiku 4.5.
Neither contrast resolved. The SWE-bench delta is +0.111 with a 95% interval of
[-1, 1], because three source clusters give a minimum detectable effect of 1.568
against an estimand bounded in [-1, 1]. The checkpoint-evolution arms separated
completely at stage 3, but on a byte-budget overrun rather than on any verdict, so
the mechanism is unsettled. [`docs/FINDINGS.md`](docs/FINDINGS.md) has the
per-instance numbers and the design gaps.

GSM8K has never called a real provider. Its evidence is scripted agents against
real-shaped rows, exercising construction, all three arms, history-sensitive
execution, grading, manifest validation, JSONL round-trips, missing-outcome
bounds, and source-clustered reporting. Parallax has no generated benchmark pool
and reproduces no paper score.

The method contracts, the implementation choices, and every deliberate divergence
from the consulted upstream implementations live in
[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) and
[`docs/methods/checkpoint-evolution.md`](docs/methods/checkpoint-evolution.md).

> **TODO:** Run the matched arm on SWE-bench, or run GSM8K against a real
> provider. Until one of those happens, no Evolving Intent flow has both a
> complete design and real-model evidence. Checkpoint evolution needs the byte
> budget and reply format settled before its stage-3 separation means anything.
