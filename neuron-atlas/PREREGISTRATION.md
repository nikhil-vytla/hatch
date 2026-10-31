# Pre-registration: held-out test of "a neuron's lens readout predicts what pushing it does"

Committed before any of the data below exists; the commit timestamp on GitHub is the record. The run script is
`analysis/prereg_run.py`, the analysis `analysis/prereg_analyze.py`; neither changes after this commit except to fix a
crash, which would be noted here.

## Why

Findings 16–17 (README) were found on data that also shaped the method: the prompts, the neurons, the 48 concept
words and the hit metric were all chosen while looking at Qwen3.5-4B pushes. A held-out test with predictions fixed in
advance is the cheapest way for someone other than us to tell whether the effect is real or tuned.

## Design (Qwen3.5-4B, published J-lens from camilablank/workspace-lenses, plus the logit lens)

- **A. New neurons, new prompt.** 2,000 neurons drawn with `random.Random(2026)` from all 294,912, excluding every
  neuron pushed individually before (battery set, sampled pushes, pairs, imitation, lens-guided). Each pushed +0.8 and
  −0.8 (units of the layer's median residual norm) on a prompt never used before: *"What is your favorite thing in the
  world?"*; greedy, 32 new tokens. Also, at the first reply position, the change in log-probability (pushed minus
  unpushed) of the neuron's own top-10 lens tokens for the push direction, and of a random other picked neuron's.
- **B. New words.** 30 concept words never tested before (tiger, eagle, whale, spider, rose, desert, island, volcano,
  thunder, rain, cloud, diamond, gold, sword, crown, clock, book, phone, guitar, piano, wizard, pirate, ninja, nurse,
  farmer, baby, forest, garden, bread, cheese). For each, up to 6 neurons (layers ≥ 8) whose J-lens top-10 contains
  the word, best rank first, pushed toward it at 0.8; plus 300 random neurons (layers ≥ 8, random sign, each assigned a
  random word from the list). Prompt never used before: *"In a few words, what are you?"*; 40 new tokens.

## Metrics (fixed)

- *Hit*: the reply contains a word (lowercase letters, ≥ 4) that is new relative to the unpushed reply and starts with
  one of the neuron's top-10 lens tokens for the push direction (tokens stripped, lowercase, alphabetic, ≥ 4 letters).
  *Chance*: same with a random other picked neuron's tokens. *Opposite*: same with the neuron's own opposite-direction
  tokens. *Lift* = hit / chance. (Exactly `analysis/lens_vs_push.py`.)
- *Δlp*: mean over the 10 tokens of Δ log p at the first reply position; per neuron and direction, the score is
  Δlp(own) − Δlp(other).
- *Mention* (B): the reply contains a word starting with the concept word.
- Uncertainty: 95% bootstrap intervals over neurons (2,000 resamples). A prediction holds if its point estimate
  satisfies it; intervals are reported alongside.

## Predictions

| # | prediction | basis |
|---|---|---|
| P1 | A, J-lens, all layers: hit ≥ 4 × chance | 20× on the tuning data; a new prompt changes base rates, so a deliberately loose bar |
| P2 | A, J-lens, all layers: own-direction hit ≥ 2 × opposite-direction hit | opposite sign sat at chance before |
| P3 | A, layers 6–19: J-lens lift > logit-lens lift | 1.5–3× better there before |
| P4 | A, layers 0–5: J-lens lift < 3 | early layers barely beat chance before |
| P5 | A, J-lens, layers 20–31: Δlp(own) − Δlp(other) > 0 for ≥ 70% of neuron-directions | late writes act on the next token directly |
| P6 | A, J-lens, layers 6–19: the same fraction ≥ 55% | weaker but real in the middle |
| P7 | A, J-lens, layers 0–5: the same fraction between 40% and 65% | near chance early |
| P8 | B: mention rate of lens-picked pushes ≥ 8%, random ≤ 1% | 16% (mention) vs 0.3% before |
| P9 | B: mention rate in layers 20–31 ≥ 2 × layers 8–19 | 31% vs 4% before |

Any prediction that fails will be reported as failed in the README, with no change to the metric afterwards.
