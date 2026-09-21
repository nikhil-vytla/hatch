# Choosing a step, a landing, or a future

Two recorded experiments test the user's idea that predicting an outcome may work better than selecting steps toward it. The first compares five Jev formulations and two code policies in simplified Tetris. The second compares four question styles for pixel drawings. These are complete exploratory protocols with visible failures, not claims that either framing wins generally.

## Tetris results

All 35 episodes completed on the same five seeded seven-bag sequences. Every Jev episode topped out without clearing a line. Both code baselines survived the 32-piece comparison horizon on every seed.

| Method | Mean pieces placed | Mean lines cleared | Jev decisions across five games |
|---|---:|---:|---:|
| Play Tetris, one button at a time | 10.8 | 0 | 54 |
| Specific next-button instruction | 9.4 | 0 | 66 |
| Choose a reachable landing | 9.8 | 0 | 49 |
| Choose a resulting board | 11.4 | 0 | 57 |
| Choose a two-piece future | 13.0 | 0 | 65 |
| One-piece code heuristic | 32.0 | 10.6 | 0 |
| Two-piece code heuristic | 32.0 | 11.4 | 0 |

The outcome method selected the first placement, `p0`, in 49/57 decisions; two-piece future selected it in 50/65. The broad goal selected Drop in all 54 decisions. This raises a position/representation concern, but there is no shuffled-choice control here, so it does not establish position bias as the cause. More pieces placed is not useful evidence of better planning when all model policies clear zero lines.

The engine uses a 10×20 board, five fixed seeds, a 12-button allowance per piece and a 32-piece horizon. It has no gravity, hold or tucks. A breadth-first search enumerates reachable top-of-board moves and a hard drop; each candidate retains its executable button path. Model observation exposes the current board and next two pieces, not the full future bag or the baseline utility value. Code computes exact resulting boards for the outcome condition and a heuristic-selected next placement for the two-piece condition. These information and computation differences are confounds if interpreted as a pure wording comparison.

This protocol remains a bounded comparison. The user's separate request for full real-time games is explored in [Life keeps moving](../real-time-playground/README.md), where the world continues while decisions are pending. The comparison's manual controls are not a finished real-time Tetris implementation.

## Drawing results

All 33 case/method maps completed, with 256 pixel decisions each. Six geometric cases have exact independent code masks; three creative subjects have no objective reference. Each case/method has one frozen pass.

| Framing | Mean geometric intersection over union | Mean pixel accuracy |
|---|---:|---:|
| Direct five-level whiteness Score | 57.3% | 80.7% |
| Noul shape membership | 56.6% | 76.8% |
| Membership with an explicit formula | 62.2% | 84.4% |
| Sequential rows with prior predictions | 52.0% | 76.5% |

Formula assistance helped the square-with-a-window case, with IoU 92.6% versus 55.7% for direct intensity, but hurt the diagonal band, 52.3% versus 76.5%. Every sailboat map had zero foreground pixels at the declared 0.5 threshold. The scanline cat was also empty. The gallery retains those maps and distinguishes grayscale intensity from the thresholded mask.

Noul returns a membership probability. Rendering it as brightness is a display choice, not evidence of calibrated brightness. Direct Score uses five ordered labels and divides its returned value by four. Geometry is a code-solvable control; creative icons need blinded human judgments or a predeclared reference before aesthetic accuracy can be discussed. Sequential rows receive prior predictions and require more native calls, so they differ in context and computation as well as wording.

## Reproduce and inspect

Run from the repository root:

```sh
bun jev-experiments/outcome-framing/verify.ts
bun test jev-experiments/outcome-framing/tetris.test.ts jev-experiments/outcome-framing/drawing.test.ts
bun jev-experiments/outcome-framing/record.ts prepare
```

`verify.ts` replays all 611 game transitions and reconstructs all 8,448 pixel values from accepted responses. It checks exact request hashes, unique accepted responses, complete answer coverage, terminal states, reference masks and metrics. The archive contains 292 accepted native requests and 369 transport attempts. Provider retries are retained separately; accepted weak answers are never retried to obtain a better result. `prepare` regenerates published JSONL from accepted evidence without model calls.

The app routes are `#experiment/tetris` and `#experiment/drawing-framing`. Playback is explicitly an animation of recorded states, with model-request time shown separately. Every supplied prompt, chosen answer and predicted pixel remains inspectable. A keyboard slider selects the same pixel in every map. Live runs use only the visitor's memory-held Gateway key and invalidate pending answers when context changes.

## What to test next

Freeze a matched set of nonempty board states, then compare exact grids with computed feature descriptions, native shared-state encoding with per-question embedding, and shuffled candidate identities. Test independently scored outcome factors against a single many-option Choice while keeping the same executable candidates. Run complete games only after these probes identify a controller worth studying; preserve this first failed protocol unchanged.

For drawing, test a shared semantic sketch or explicit shape decomposition before asking independent pixels. Compare resulting coherence against per-pixel membership on new prompts, with human preference labels for creative subjects. [TypeSafe's introduction](https://docs.typesafe.ai/introduction) recommends decomposing decisions that combine multiple independent factors; that is a useful next hypothesis, not an explanation already established by these results.
