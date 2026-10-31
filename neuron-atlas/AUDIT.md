# Audit of the LLM-judged results

Many results in the README count labels written by an LLM judge (DeepSeek-V4.1-Flash, "the first judge"). This file
records how far those labels can be trusted, by three checks that do not depend on the first judge.

## 1. A second judge (done)

`analysis/second_judge.py` re-judged 120 items per task with the same instructions, using DeepSeek-V4-Pro. No model
from another lab was reachable from the run environment (OpenCode's free models failed server-side; Bedrock had no
credentials), so this is a different, larger model from the same lab: a partial check, not an independent one.

| task (finding) | agreement | Cohen's κ | items | key class | second judge confirms | adds |
|---|---|---|---|---|---|---|
| reply became the concept (17) | 95% | 0.84 | 120 | became | 21 of 27 (78%) | 0 |
| reply kind of a sweep reply (9, 20) | 82% | 0.74 | 120 | persona | 47 of 60 (78%) | 0 |
| our label vs neuron-lens's (cross-check) | 84% | 0.74 | 114 | same | 24 of 36 (67%) | 1 |
| outcome of two pushed personas (18) | 76% | 0.70 | 105 | fused | 17 of 25 (68%) | 6 |

(κ above 0.6 is usually read as substantial agreement.) The second judge is stricter in one direction on three
tasks: it never upgrades a reply to "became" or "persona", and it downgrades about a fifth of them, mostly persona →
"altered assistant" (an assistant with a new name) and "same" → "related". **Read the judged rates as upper bounds,
roughly 20–30% high**: lens-guided "became" ~14% rather than 18% (random neurons stay at 0), the persona share of
Qwen3.5-4B pushes ~0.6% rather than 0.8%, and "same" label agreement ~22% rather than 33% (with "related" absorbing the
difference; same-or-related is unchanged at ~80%). Fusion nets out: it drops 8 "fused" verdicts and adds 6. Every
comparison against random controls keeps its direction, because the controls are judged by the same judge.

Data: `second_judge.json` on the Hub (`Qwen__Qwen3.5-4B/experiments/`).

## 2. A blind human audit (open)

[Blind audit page](https://claude.ai/artifact/814zWnrQX6CGPsEbEZ6bkr) (shared by its owner): the first 30 items of each
task above, 120 in all, interleaved, shown without either judge's answer. Each rater's answers are stored under their
own id; raters cannot see each other's. Score with `python audit/score.py <ratings dump>` (human vs first judge, human
vs human, κ per task). The key is `audit/key_deepseek.json`; raters should not look at it.

## 3. A pre-registered held-out test (done)

`PREREGISTRATION.md`: predictions committed (e5e51ac, 2026-10-31 02:20 UTC) before the data existed; 8 of 9 held. Its
"mention" metric for lens-guided pushes is a string match, not a judge, so it is unaffected by the bias above: 14.8%
of lens-picked pushes mention the new word vs 0.0% of random ones.

## 4. Recomputation from public data

`verify.py` recomputes 35 headline numbers from the Hub dataset alone (`CLAIMS.md`): 35 of 35 pass after four README
numbers were corrected to what the data gives.
