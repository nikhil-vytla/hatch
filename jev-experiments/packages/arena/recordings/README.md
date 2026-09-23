# Tetris question designs, recorded

Jev played turn-based Tetris on seeds 7, 19 and 42, with three ways of asking where each piece should land. Each design had its own lane in the same arena, so every design saw the same pieces. Turns make latency irrelevant. Games stop at 40 pieces. Weak answers were never retried; a failed request drops the piece where it spawned.

| Seed | Pick one landing (JSON features) | Judge each spot: clean or not | Rate each spot 0–3 | Code planner | Perfect reader of the sentences |
|---|---|---|---|---|---|
| 7 | 2 lines, topped out at 23 pieces | 13 | 15 | 15 | 14 |
| 19 | 7 | 14 | 8 (3 rejected answers) | 14 | 12 |
| 42 | 7 | 12 | 13 (1 rejected answer) | 12 | 13 |

The spot designs follow Laya's playground: code describes each distinct landing in one sentence (new holes, bump, lines completed), Jev judges each sentence in one batched request, and code picks the best-judged spot, keeping the leftmost on ties. "Perfect reader" answers from the sentence text alone; it bounds what the sentences allow. Four rating answers were rejected by the gateway because Jev's native Score disagreed with its own distribution.

Median time per decision: about 0.6 s picking one landing, 1.1 s judging each spot, 1.7 s rating each spot. Gateway cost reported zero where known; 43 requests have unknown cost.

Files:

- `tetris-framings.replay.jsonl`: answers the site replays (requests are rebuilt exactly from the game).
- `tetris-framings.jsonl.gz`: every request and reply.
- `tetris-framings-summary.json`: per-lane results.
- `attempt-1-provider-busy.*`: the first attempt, which sent three requests at once and hit provider capacity (93 of 127 failed). It measures availability, not the designs, and is kept as recorded.

Record a new run with `bun jev-experiments/packages/arena/scripts/record-framings.ts` after moving these files; the recorder refuses to overwrite them.
