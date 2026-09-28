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

## Judgement puzzles: orders and routing

Tetris and grid questions turned out to test counting and route-finding, which Jev does
poorly and people do at a glance. These two kinds test reading and judging instead: the text
is written from hidden facts, both a person and Jev read the same words, and code applies the
facts to decide the answer.

### Order (`order.ts`)

A customer states one to three requests in their own words ("I'm off caffeine this month",
"keep it under five bucks", "no cow's milk, oat or almond is totally fine though", typos
included), and the barista proposes a drink shown as a card (drink, milk, syrup, caffeine in
mg, sweetness, price, hot or iced). The requests are hidden structured facts: no dairy, no
caffeine or 50 mg or less, a price limit, hot or iced, no sugar or not too sweet, no tree nuts
(almond milk and hazelnut syrup count). A quarter of customers also state a request and take
it back ("I'd normally skip caffeine, but today I really need it"); a retracted request no
longer applies but still appears among the options. At most one request is broken.

- `meets_all` (yes/no): the drink meets everything the customer still wants.
- `breaks` (choice): which request it breaks, each request mentioned (retracted ones too) or
  "none".
- `meets_one` (yes/no): the drink satisfies one named request.

### Route (`route.ts`)

A team's policy of three to five numbered rules from a pool, then "everything else goes to
Support"; rules are checked in order and the first that applies wins. Messages sent to
Security or On-call need a person today. The customer message is written from hidden facts:
the topic (refund, security, outage, shipping, login, feature idea, billing question), an
amount if any, and whether the customer is upset. Two rules can apply to one message (a
hacked account with an unrecognized charge is both a security report and a question about a
charge), so the order decides; "over $100" excludes exactly $100; a calm outage report falls
through an "upset and down" rule. Topics are weighted towards these cases.

- `team` (choice): which team gets the message, among the teams the policy names.
- `today` (yes/no): the message needs a person today (Security or On-call).

`judgement-bank.json`: 75 orders (38 meet everything, 37 break one request; 31 harder: a
retraction or three requests) and 75 routes (30 hard) from seeds 1 upward
(`scripts/generate-judgement.ts`). Recorded the same way as the Tetris and grid bank:
`bun packages/arena/scripts/record-checkable.ts judgement-bank.json judgement`, reported with
`bun packages/arena/scripts/checkable-report.ts judgement-bank.json judgement`.

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

## Judgement results (recorded 26 Sep 2026)

150 items, 414 attempts (63.8% busy and retried), latency median 270 ms, 90th percentile
437 ms, no answers dropped. Against the answers code computes:

| Question                        | n   | Jev right | Most common answer | Jev log score | Uniform |
| ------------------------------- | --- | --------- | ------------------ | ------------- | ------- |
| Order · breaks which request    | 75  | 90.7%     | 50.7%              | −0.205        | −1.090  |
| Order · meets everything        | 75  | 89.3%     | 50.7%              | −0.273        | −0.693  |
| Order · meets one named request | 75  | 98.7%     | 70.7%              | −0.085        | −0.693  |
| Route · which team              | 75  | 86.7%     | 32.0%              | −0.381        | −1.491  |
| Route · needs a person today    | 75  | 82.7%     | 74.7%              | −0.412        | −0.693  |

Easy and hard items differ: "which request does it break" is 97.7% right on easy orders and
80.6% on hard ones (a retraction or three requests); "which team" is 97.8% on easy routes and
70.0% on hard ones (rule order, an amount at the threshold, a calm outage).

Calibration error across all 375 answers is 0.010: stated 50–60% was right 52.9% of the time,
60–70% → 65.0%, 70–80% → 73.3%, 80–90% → 82.9%, 90–100% → 95.8% (192 answers). Orders are
slightly underconfident (90–100% → 99.2%); routes slightly overconfident (90–100% → 89.1%).

Reading and judging is where Jev is strong, unlike the Tetris and grid questions above, and
its confidence is honest about the hard cases, which is what a game against it needs.

## Jev Daily: trust or override

`build-daily.ts` turns every eligible question into its own puzzle (Tetris "completes a row",
order, route, phrase; grid is left out) with Jev's recorded distribution, and measures per
kind how often Jev's top answer is right in each confidence band. The page shows Jev's answer,
how sure it was, and that band's record; the visitor keeps it or overrules it. Scoring is a
count: how many you got, against how many Jev alone would have.

`pickDaily(items, date)` (`daily.ts`) gives one puzzle each of order, route, phrase and
Tetris where Jev is under 90% sure, plus one it is sure of, walking fixed shuffles. A game
where Jev is always sure is unwinnable (it is right 98% of the time there), so the hesitant
ones carry the day. The bands are uneven, which is the game: on Tetris 60–70% is right 96%
of the time, on routes 43–56%.
