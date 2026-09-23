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

## Real time

The same designs in real time: gravity never waits, one game per design, one request in flight, 40 pieces. Transport follows the real-time demos: at most two attempts within 4 s, an answer for a locked piece is dropped at once, and a failed request is re-asked 400 ms later. Lines cleared on seeds 7, 19 and 42:

| Design | Lines | Game time for 40 pieces | Requests | Rate-limited (429) |
|---|---|---|---|---|
| Pick one landing | 5, 6, 7 (two games topped out near 40) | 47–74 s | 261 | 143 |
| Judge each spot | 13, 13, 13 | 78–87 s | 367 | 247 |
| Judge each spot, remembering past judgements | 10, 6, 9 | 40–42 s | 148 | 28 |

Successful requests took about 300 ms at the median for every design. Almost every failure was a 429 rate limit, even with one request in flight: re-asking after 400 ms keeps hitting the limit. Remembering judgements avoided most requests (about 1,285 spot judgements came from memory), so it hit the limit least and played fastest, but it cleared fewer lines. Its questions carry one sentence with no other spots for comparison, and a first judgement is reused for the rest of the game.

Files: `realtime.replay.json` (every decision with world send and arrival times; replays exactly) and `realtime.jsonl.gz` (every request and reply).

Record new runs with `bun jev-experiments/packages/arena/scripts/record-framings.ts` or `record-realtime.ts` after moving these files; the recorders refuse to overwrite them.
