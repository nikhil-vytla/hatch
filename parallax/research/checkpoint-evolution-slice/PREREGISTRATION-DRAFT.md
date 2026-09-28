# Preregistration draft: first paid checkpoint-evolution run

Status: **executed 2026-08-03** with the design below, unchanged.
Results and decision: [screening-report.md](screening-report.md).
Evidence: `evidence/screening.jsonl` (60/60 stage calls delivered and
validated), actual spend \$0.2813 against the \$5 cap.

Launch command used (from `parallax/`, with the key exported):

```bash
uv run python research/checkpoint-evolution-slice/run_screening.py \
    --live --approve-spend
```

## Question

RQ1 (self-accumulation, screening-grade): with the sealed suites,
obligations, budgets, and agent configuration matched, does an agent
that extends *its own* prior workspace (`evolved`) verify differently at
stages 2 and 3 than the same agent opening each stage from the *frozen
reference* workspace (`carry-reference`)?

At this scale the run is primarily a harness-validation gate, the CE
analog of the EI screening round, not a confirmatory test. One family
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
(~\$1/M input, ~\$5/M output): \$0.004–\$0.008 per call, **\$0.25–\$0.50 for
the 60-call design**; with a 2× retry-and-overhead margin, under \$1.
Hard spend cap: **\$5** (the repo's default screening cap). Stop rules:
hard-stop at the cap; stop and diagnose if RunFailures exceed 30% of
stage calls or if any evidence-validation error occurs.

## Prerequisites before the first call

1. **Met.** Provider adapter mapping the chat boundary onto
   `CheckpointAgent` (workspace-serialization prompt + strict JSON file
   map parse): `src/parallax/checkpoint_agent.py`
   (`ProviderCheckpointAgent`). The runner gained only an optional
   `StageReceipt.usage` field and an execution seam; delivery,
   classification, and evidence semantics are unchanged.
2. **Met.** Sandboxing: every `verify_stage` call on the live path runs
   each sealed case in a disposable container
   (`src/parallax/checkpoint_sandbox.py`): digest-pinned
   `python@sha256:57cd7c…710de` under `--platform=linux/amd64`, no
   network, read-only rootfs except the working directory, non-root
   user, CPU/memory/pid limits, in-container case timeout. There is no
   host fallback on the live path (gauntlet mutant M15 kills it).

Dry-run evidence: `evidence/dry-run.jsonl` (preregistered 10-seed
shape, 60/60 stages verified, scripted gateway, \$0) and
`evidence/dry-run-sandbox.jsonl` (2 seeds through the real container
sandbox, 12/12 stages verified).

## Decision rule

- **Proceed** to multi-family synthesis (workflow S1–S6) if the harness
  produces complete, validated evidence for ≥ 90% of scheduled stage
  calls, whatever the contrast shows.
- **Fix first** if RunFailures or evidence-validation errors exceed the
  stop thresholds.
- Any observed evolved-vs-carry separation is hypothesis-generating
  only; the confirmatory version requires ≥ 20 admitted families and a
  preregistered clustered interval, costed separately.
