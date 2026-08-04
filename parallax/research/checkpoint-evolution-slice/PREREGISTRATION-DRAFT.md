# Preregistration draft: first paid checkpoint-evolution run

Status: **awaiting approval — no paid inference has run.** This is the
experiment design required before any spend, per the slice's stop rule.

## Question

RQ1 (self-accumulation, screening-grade): with the sealed suites,
obligations, budgets, and agent configuration matched, does an agent
that extends *its own* prior workspace (`evolved`) verify differently at
stages 2 and 3 than the same agent opening each stage from the *frozen
reference* workspace (`carry-reference`)?

At this scale the run is primarily a harness-validation gate — the CE
analog of the EI screening round — not a confirmatory test. One family
is one cluster; no clustered interval will be claimed.

## Design

| Field | Value |
|---|---|
| Task family | `ce-tally-1`, the admitted seed family (digest `7704…274d`), 3 checkpoints, 10 sealed cases |
| Conditions | `evolved` vs `carry-reference` (the implemented matched pair) |
| Trials | 10 trial seeds × 2 arms × 3 checkpoints = 60 provider calls |
| Model | Claude Haiku 4.5 through the existing OpenAI-compatible provider boundary (same boundary model class as the SWE-bench screening) |
| Agent boundary | one call per checkpoint: public spec + serialized carried workspace in, full file map out, parsed strictly into `Workspace`; a rejected or oversized reply is the stage's RunFailure (budget/agent) exactly as the runner already classifies |
| Budgets | per-stage 4096-byte workspace cap (declared in the family); per-call max output tokens 2048 |
| Outcomes | per-stage strict/isolated/core verdicts; per-seed paired evolved−carry differences at stages 2 and 3; RunFailure rates by kind |
| Evidence | `run_ce_experiment` manifest + family + run records, canonical JSONL, committed with the analysis |

## Cost estimate

Per call: ~1.5–2.5k input tokens (spec ≈ 450–700, workspace ≈ 400–900,
protocol overhead) and ~400–900 output tokens. At Haiku-class pricing
(~$1/M input, ~$5/M output): $0.004–$0.008 per call, **$0.25–$0.50 for
the 60-call design**; with a 2× retry-and-overhead margin, under $1.
Hard spend cap: **$5** (the repo's default screening cap). Stop rules:
hard-stop at the cap; stop and diagnose if RunFailures exceed 30% of
stage calls or if any evidence-validation error occurs.

## Prerequisites before the first call

1. A small provider adapter mapping the chat boundary onto
   `CheckpointAgent` (workspace-serialization prompt + strict JSON file
   map parse). No harness change; the runner and receipts are frozen.
2. Sandboxing: the verifier executes model-written Python. The whole
   run (or at minimum every `verify_stage` call) must execute inside a
   disposable container with no network and a non-root user — the same
   lesson the SWE-bench screening safety audit enforced. The offline
   slice is safe only because its agents are scripted.

## Decision rule

- **Proceed** to multi-family synthesis (workflow S1–S6) if the harness
  produces complete, validated evidence for ≥ 90% of scheduled stage
  calls, whatever the contrast shows.
- **Fix first** if RunFailures or evidence-validation errors exceed the
  stop thresholds.
- Any observed evolved-vs-carry separation is hypothesis-generating
  only; the confirmatory version requires ≥ 20 admitted families and a
  preregistered clustered interval, costed separately.
