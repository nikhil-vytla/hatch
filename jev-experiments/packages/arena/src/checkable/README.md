# Checkable items

Items whose right answer code computes from the state: no soft reference, no authored label.
Scores against them mean right or wrong. They feed Jev Daily (a human-vs-Jev commit and reveal
game) and are the first test of Jev against ground truth in this repo.

Each item is `{ id, kind, seed, difficulty, state, questions, truth }` (`items.ts`). `state`
and `questions` are exactly what Jev is sent; `truth` never leaves the bank.

## Tetris (`tetris.ts`)

A mid-game board from a seeded game played by the engine's code planner, with 30% careless
placements so boards have realistic mess. The state shows the board rows ('#' filled, '.'
empty, empty rows above the stack left out), the falling piece, and three labelled landings
(A, B, C), each drawn as the same board with the piece's cells as '@'. The state states no
computed features (no line counts, hole counts or heights), so the picture has to be read.

Questions, answers from the engine (`landings`, `boardFeatures`):

- `fewest_holes` (choice A/B/C): which landing leaves the fewest buried empty cells after the
  piece lands and full rows disappear. Always a unique minimum.
- `lowest_stack` (choice): which leaves the lowest highest column. Always unique.
- `completes_A/B/C` (yes/no): the landing fills at least one row completely.
- `most_lines` (choice): which clears the most rows; only asked when some landing clears one
  and the maximum is unique.

Candidates come from the better half of reachable landings. When a row can be filled, a
landing that fills it is offered 70% of the time. The bank keeps 75 items with a row to fill
and 75 without, so "fills a row" is not almost always no.

## Grid (`grid.ts`)

A 7×7 to 9×9 maze: walls '#', floor '.', agent A, key K, locked door D (passable only
carrying the key), exit E. Half the grids are vaults: a wall across the middle with the door as
its only gap, and in most vaults the agent and key start on the far side from the exit. The
answers come from breadth-first search over (square, has key).

- `can_exit` (yes/no): the agent can reach the exit.
- `needs_key` (yes/no): every route to the exit goes through the door; asked only when the exit
  is reachable.
- `first_step_to_key` (choice up/down/left/right): first move on the shortest route to the key;
  asked only when every shortest route starts the same way.
- `exit_distance` (score, 3 levels): fewer than 8 steps; 8 to 14; 15 or more, or unreachable.

Grids where the exit or key is next to the agent are skipped as too easy.

## The bank

`bank.json`: 150 Tetris and 150 grid items from seeds 1 upward
(`scripts/generate-checkable.ts`), 477 KB. Generation is deterministic; a test checks the
bank parses, every answer is one of its question's options, and the daily set is stable.
`dailySet(bank, "YYYY-MM-DD")` gives five items (three Tetris, two grid) walking a fixed
shuffle, so none repeats until the bank is used up.

## Recording (`scripts/record-checkable.ts`)

One call per item with all its questions batched, items in a seeded shuffled order, one
request at a time with a 700 ms gap. Busy replies (429/503) and network failures are waited out
and asked again; every attempt is logged. The recorded latency is the successful attempt's.
A Score the gateway drops is kept as dropped. The log is append-only and resumable; the raw
file is gitignored and `recordings/checkable.jsonl.gz` is committed.

## Results (recorded 26 Sep 2026)

All 300 items answered (`scripts/checkable-report.ts`). 858 attempts, 558 of them busy
(65%), so the run took about 55 minutes; median latency 273 ms, 90th percentile 424 ms; no
Score dropped by the gateway.

| Question                      | n   | Jev right | Always the most common answer | Log score | Uniform guess |
| ----------------------------- | --- | --------- | ----------------------------- | --------- | ------------- |
| Tetris · fills a row (A/B/C)  | 450 | 92.7%     | 83.3%                         | −0.426    | −0.693        |
| Tetris · clears the most rows | 75  | 88.0%     | 38.7%                         | −0.748    | −1.099        |
| Tetris · fewest buried cells  | 150 | 45.3%     | 35.3%                         | −1.068    | −1.099        |
| Tetris · lowest stack         | 150 | **23.3%** | 38.7%                         | −1.225    | −1.099        |
| Grid · can reach the exit     | 150 | 60.0%     | 58.0%                         | −0.641    | −0.693        |
| Grid · needs the key          | 87  | 64.4%     | 63.2%                         | −0.653    | −0.693        |
| Grid · first step to the key  | 65  | 56.9%     | 27.7%                         | −1.178    | −1.386        |
| Grid · distance to the exit   | 150 | **32.7%** | 44.7%                         | −1.134    | −1.099        |

Calibration (stated confidence of the top answer → how often it is right), calibration error
0.072 over all 1,277 answers:

| Stated | 30–40%      | 40–50%      | 50–60%      | 60–70%      | 70–80%      | 80–90%     | 90–100%    |
| ------ | ----------- | ----------- | ----------- | ----------- | ----------- | ---------- | ---------- |
| All    | 37.5% (112) | 41.1% (258) | 57.6% (316) | 77.9% (271) | 88.1% (236) | 84.7% (72) | 63.6% (11) |
| Tetris | 37.5% (96)  | 46.4% (183) | 68.5% (178) | 87.1% (171) | 98.1% (155) | 100% (42)  | —          |
| Grid   | 37.5% (16)  | 28.0% (75)  | 43.5% (138) | 62.0% (100) | 69.1% (81)  | 63.3% (30) | 63.6% (11) |

What it shows:

- Reading these pictures is hard for Jev. Where a question needs local pattern-spotting (does
  a row fill, which landing clears the most) it is strong; where it needs comparing whole
  boards or tracing a route it is near or below a trivial baseline. On "lowest stack" it is
  worse than a random pick, although the answer is visually obvious: on 148 of 150 items the
  right landing is simply the one whose piece is drawn lowest. Jev picks that one 23% of the
  time. "Distance to the exit" is below always guessing the most common level.
- Its confidence still carries signal. Answers it states more confidently are right more
  often (37% at 30–40% up to 88% at 70–80%), and it rarely claims high confidence: only 84 of
  1,277 answers are above 80%.
- Calibration differs by kind. On Tetris Jev is underconfident: at 70–80% stated it is right
  98% of the time. On grids it is overconfident: at 80–100% stated it is right about 63%.
- Log scores beat a uniform guess overall (Tetris −0.717 vs −0.877; grid −0.884 vs −0.927) but
  not on lowest stack or distance to the exit.

For Jev Daily this is useful rather than embarrassing: a careful person can beat Jev on these
items, and its confidence says where. The weak question types (lowest stack, distance) are
where a human should win; the strong ones (fills a row, clears the most) are where Jev should.
