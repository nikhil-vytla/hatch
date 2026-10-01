# The reef

`#experiment/ocean`: about 120 fish, each choosing its next action (school, eat, hide, flee, follow, signal, rest) from what it can see. Code runs everything else, and a fish keeps its last action until a new decision arrives.

## The free decider: an evolved policy

`policy.ts` is a two-layer network (17 inputs, 10 hidden units, 7 actions; 257 weights in `policy.json`, 7 KB). It uses arithmetic only, so every JavaScript engine decides alike. `train.ts` evolved it with an evolution strategy (antithetic Gaussian perturbations, centred-rank fitness, Adam):

- **Fitness:** the share of an event's fish that survive, plus the share alive at the end.
- **Training data:** seeds 100–999 and four events: heatwave, net, storm and bloom. Oil spills were held out entirely.
- **Checkpoint:** chosen on validation seeds 1000–1011. 70 generations; generation 65 was kept (validation 2.296).

No model's answers were used anywhere. TypeSafe's Master Customer Agreement §2.3(b) forbids training a model to imitate Jev, so the recorded Jev run (`recordings/jev-heatwave.jsonl.gz`) is a comparison on the page and nothing else.

```sh
bun live-worlds/ocean/train.ts --generations 70     # writes policy.json
bun live-worlds/ocean/heldout.ts                    # writes heldout.json
```

## Held-out results (`heldout.json`, 30 Sep 2026)

Test seeds 5000–5019 were never used in training or selection. Each run puts the event at 15 s, lasts 60 s and starts with 120 fish. Each cell gives the share of the event's fish that survived, as a mean ± standard deviation over 20 seeds.

| Decider | Heatwave | Net | Storm | Bloom | Oil (unseen) |
|---|---|---|---|---|---|
| Nobody decides | 79% ± 2 | 9% ± 11 | 93% ± 2 | 92% ± 3 | 60% ± 17 |
| Hand-written rule (`rule.ts`), 10 a second | 94% ± 2 | 85% ± 11 | 94% ± 2 | 96% ± 2 | 90% ± 3 |
| Evolved policy, 10 a second | 89% ± 4 | 82% ± 10 | 98% ± 1 | 99% ± 1 | 85% ± 8 |
| Evolved policy, 5 a second | 57% ± 8 | 52% ± 16 | 91% ± 3 | 91% ± 2 | 60% ± 6 |
| MobileBERT, 5 a second | 78% ± 4 | 4% ± 4 | | | |

MobileBERT ran on heatwave and net only, because it's slow. Its 5-a-second budget is what it managed in the browser (about 185 ms per fish), and the evolved policy is shown at the same budget for a fair comparison.

**What it shows:**
- At full speed, the evolved policy is far better than MobileBERT and than doing nothing. It's best on storms and blooms.
- The short hand-written rule still beats it on heatwaves, nets and oil.
- Decision rate matters as much as the decider. At 5 a second, the evolved policy does worse than leaving fish alone in a heatwave, because fish act on stale decisions.

The held-out run happened on a Linux L4 workspace (Bun 1.4.2). One episode was first checked to match the Mac exactly (Bun 1.3.14).

## Files

- `engine.ts`: the world
- `render.ts`: canvas drawing
- `models.ts`: Jev and MobileBERT requests
- `replay.ts`: the recorded race
- `policy.ts`, `policy.json`, `train.ts`, `train-worker.ts`: the evolved policy
- `rule.ts`: the hand-written baseline
- `evaluate.ts`, `heldout.ts`, `heldout-worker.ts`: episode runs and the held-out table
- `record.ts`: the one Jev recording

Tests are `engine.test.ts`, `replay.test.ts` and `policy.test.ts`.
