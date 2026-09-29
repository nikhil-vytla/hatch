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

## Robustness of "judge each spot"

**Position and batching.** 30 boards from the recorded turn-based games (seeds 7, 19, 42; pieces 1, 5, …, 37), 296 spot judgements, each asked four ways. No request failed.

| Comparison with the original order | Mean change in P(clean) | Judgements moved by more than 0.2 | Same chosen spot |
|---|---|---|---|
| Asked again, same order | 0.008 | 0 | 30 of 30 |
| Reversed order, labels reassigned | 0.027 | 7 | 30 of 30 |
| Each sentence in its own request | 0.049 | 22 | 28 of 30 |

Jev gives nearly the same answer when asked twice. Reversing the order moves judgements a little more than chance but never changed which spot code chose. Asking about spots one at a time moves them most and changed the choice on 2 of 30 boards, so seeing the other spots matters somewhat; batching is also one request instead of about ten.

**More seeds.** Turn-based 40-piece games on four new seeds, one lane per design in the same arena. Lines cleared:

| Seed | Pick one landing | Judge each spot | Code planner |
|---|---|---|---|
| 3 | 3 (topped out at 30 pieces) | 12 | 14 |
| 11 | 1 (topped out at 23 pieces) | 14 | 15 |
| 23 | 11 | 8 | 14 |
| 31 | 7 | 11 | 13 |

Across all seven seeds, judging each spot averaged 12.0 lines, picking one landing 5.4 (four of seven games topped out early) and the code planner 13.9. Judging each spot lost to picking one landing on seed 23.

Files: `robustness-position-summary.json` and `.jsonl.gz`; `turns-more-seeds-summary.json`, `.replay.jsonl` and `.jsonl.gz`.

## Real time

The same designs in real time: gravity never waits, one game per design, one request in flight, 40 pieces. Transport follows the real-time demos: at most two attempts within 4 s, an answer for a locked piece is dropped at once, and a failed request is re-asked 400 ms later. Lines cleared on seeds 7, 19 and 42:

| Design | Lines | Game time for 40 pieces | Requests | Rate-limited (429) |
|---|---|---|---|---|
| Pick one landing | 5, 6, 7 (two games topped out near 40) | 47–74 s | 261 | 143 |
| Judge each spot | 13, 13, 13 | 78–87 s | 367 | 247 |
| Judge each spot, remembering past judgements | 10, 6, 9 | 40–42 s | 148 | 28 |

Successful requests took about 300 ms at the median for every design. Almost every failure was a 429 rate limit, even with one request in flight: re-asking after 400 ms keeps hitting the limit. Remembering judgements avoided most requests (about 1,285 spot judgements came from memory), so it hit the limit least and played fastest, but it cleared fewer lines. Its questions carry one sentence with no other spots for comparison, and a first judgement is reused for the rest of the game.

### Run 2: backing off, and remembering only confident judgements

Run 1 re-asked failed requests after a fixed 400 ms. Rate limits usually suggest waiting 60 s, which would freeze the game, so run 2 backs off instead: 0.4, 0.8, 1.6, 3.2, then 4 s, resetting after a success, using a suggested wait only when it is 4 s or less. It also adds a fourth design: remember a judgement only when it is at least 0.3 from 0.5, and ask again about unsure or new sentences with every spot in view.

| Design | Lines | Game time for 40 pieces | Failed requests (run 1 → run 2) |
|---|---|---|---|
| Judge each spot | 13, 14, 12 | 68–88 s | 247 → 135 |
| Remember every judgement | 11, 9, 8 | 38–44 s | 28 → 15 |
| Remember only confident judgements | 12, 11, 10 | 40–51 s | 43 (new) |

Files for run 2: `realtime-2.replay.json` and `realtime-2.jsonl.gz`. Every game in both runs replays exactly under the retry policy it was recorded with.

Files: `realtime.replay.json` (every decision with world send and arrival times; replays exactly) and `realtime.jsonl.gz` (every request and reply).

Record new runs with `bun jev-experiments/packages/arena/scripts/record-framings.ts` or `record-realtime.ts` after moving these files; the recorders refuse to overwrite them.

## Which Jev answered

Every Jev recording here went through the Vercel AI Gateway as `typesafe-ai/jev`, and the gateway
never names a build: replies report `model: "typesafe-ai/jev"`, and pinned IDs such as
`typesafe-ai/jev-1.13.0` return 404 (checked 29 Sep 2026). What the gateway does say:

- Its model list gives Jev a release date of 2026-09-15. Every recording in this folder is later
  (22–29 Sep 2026).
- TypeSafe's own API reports the versioned ID that answered, and its docs say `jev-latest` points
  to `jev-1.13.0` ([docs.typesafe.ai/models](https://docs.typesafe.ai/models), read 29 Sep 2026).
  TypeSafe's workflow evals (evals.typesafe.ai) ran a build they label `v13`. So these recordings
  are most likely 1.13.0, but nothing in them proves it.
- The gateway can route Jev to more than one host (`typesafe-ai`, with `digitalocean` as a
  fallback), and it reports which one answered. From 29 Sep 2026 the arena recorders keep that
  as `servedBy`, with the gateway's `generationId`; earlier rows don't have them.

Compare these numbers with TypeSafe's only as "Jev through the gateway, around this date".

## One box (every keystroke prefix)

- `one-box.jsonl.gz`: Jev answering One box's 14 questions (after anishfn/shapeshift) for all
  5,666 distinct prefixes of the 200 authored phrases in `src/one-box/phrases.json`, recorded
  24–25 Sep 2026 by `scripts/record-one-box.ts`, one request at a time. Word-end prefixes were
  asked first, then the rest. Every attempt is kept, including about 40% that came back busy
  and were asked again; the recorded latency is the successful attempt's (median 224 ms, 90th
  percentile 381 ms). No Score was dropped by the gateway. The raw log is kept locally and
  gitignored; the compare script reads either.
- Development split (150 phrases; held-out 50 not yet scored), `scripts/one-box-compare.ts`:
  Jev's box ends on the right card for 98.0% of phrases under either request policy; the
  keyword classifier for 67.3%.

## One box: Laya (local)

- `one-box.laya.jsonl.gz`: Laya's promoted local default (`laya-readout-experimental`,
  `jev/laya-typed-readout-v1-seed17`, revision `9284b27…`, on `convaiinnovations/laya` at
  `1c5edc1…`) answering the same 14 questions for the same 5,666 prefixes as Jev, recorded
  26 Sep 2026 on an Apple M4 Max (48 GiB) with mlx 0.32.2 by `scripts/record-one-box-laya.py`
  through `roadmap/mac/jev_local.py`'s Runtime, loaded once and warm. Details in
  `one-box.laya.meta.json`. No errors; latency median 270 ms, 90th percentile 289 ms per prefix
  (all 14 questions, two local requests).
- Workarounds, not Laya's native behaviour:
  - `intent` has 20 options and Laya accepts at most 8. The options are split in question order
    into groups of 7, 7 and 6, each asked on its own, then a final choice between the three
    group winners: p(option) = p(option | group) × p(group winner in the final), renormalised.
  - The v2 runtime rejects descriptive ordinal levels, so readiness and urgency go as bare 0–2
    ordinals with the level texts appended to the prompt.
- The committed copy rounds probabilities to 4 decimals (1.8 MB); every dev-split number is
  identical to the full-precision raw log, which stays local and gitignored.
- Dev split, Shapeshift's cancel policy (`scripts/one-box-compare.ts`): Laya's box ends on the
  right card for 64.7% of phrases (keyword classifier 67.3%, Jev 98.0%), with 2.31 visible
  changes per phrase; on the full phrase alone Laya picks the right card 73.3% of the time.

### One box held-out result (scored once, 26 Sep 2026)

Run after Jev, Laya and the tiny model were all recorded, with nothing tuned: the calm-UI
thresholds and keyword rules are Shapeshift's, the tiny model trained on development prefixes
only (held-out prefixes excluded), and Laya and Jev are zero-shot.
`bun packages/arena/scripts/one-box-compare.ts cancel heldout`, 50 phrases, upstream's
cancel-on-keystroke policy (95% case-bootstrap interval from the arena card):

| Contestant | Box right at end | Full phrase right | Wrong commits / phrase | Changes / phrase |
|---|---|---|---|---|
| Jev | 94.0% (86–100) | 98.0% | 0.02 | 1.22 |
| Laya (intent asked in 3 groups) | 70.0% (56–82) | 80.0% | 0.04 | 1.98 |
| Keyword classifier | 62.0% (48–76) | 66.0% | 0.20 | 1.92 |
| Tiny model (distilled from Jev) | 30.0% (18–44) | 36.0% | 0.10 | 1.48 |

Under keep-the-latest, final cards are unchanged and the boxes change more (Jev 3.14,
Laya 5.70 per phrase). The development split gave the same order (Jev 98.0%, keyword 67.3%,
Laya 64.7%, tiny 26.7%); Laya and the keyword classifier swap places between splits and
their intervals overlap on both.

## Breaking hard questions into small ones (decompose.jsonl, 26 Sep 2026)

`scripts/decompose-experiment.ts` re-asked the first 30 Tetris and first 30 grid items of the
checkable bank (bank order, not chosen by result), one call per item, with the hard question
split into small local ones that code combines. Same state as the single-question recording.

| Question | Asked as one question | Split, combined by code |
|---|---|---|
| Tetris · lowest stack (3 pairwise "drawn lower than") | 33% (10/30) | 70% (21/30) |
| Tetris · fewest holes (per landing "empty cell under the piece") | 37% (11/30) | 53% (16/30) |
| Grid · can reach the exit (3 reachability parts) | 77% (23/30) | 67% (20/30) |

Local comparisons Jev can see at a glance help a lot; splitting route-finding into parts does
not (each part is still route-finding, and combining errors compounds). Thirty items each is a
small sample: read these as directions, not measurements.
