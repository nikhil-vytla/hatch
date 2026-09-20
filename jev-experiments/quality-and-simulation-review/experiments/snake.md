# Snake

Verdict: **redesign**. Highest priority: **P1**. Keep the finite recordings as an honest assisted-policy demonstration. Build the requested real-time game as a separate mode with its own clock, full game lifecycle, human/Jev handoff and checkpoint branches. This audit covers unchanged Snake source at `4c0c40d`; source hashes and calculations are in `probes/snake.json`. No app edits, model calls or browser session were performed. Root is exploring a separate real-time prototype with independent world/model clocks, takeover and checkpoints; that proposal does not change these findings against frozen main and was not audited here.

## Current purpose and evidence

The catalog asks whether Jev can collect food while leaving itself an escape route (`experience-prototypes/src/catalog.ts:269`). Jev chooses one of three relative turns, left, straight or right. Code supplies the complete 10×10 board, snake body, heading, food, moves remaining, and exact next-cell collision and food-distance previews for every action (`local-models-and-games/arcade/engine.ts:98`, `:128`, `:248`). Code also owns growth, collisions, seeded food and termination.

The visitor can watch a recording, request live Jev moves, or move manually with buttons/focused arrow keys. These modes share rules, but changing modes starts a new game. Replay speed is independent of recorded request timing. The final recorded state is displayed after the last action, which is a useful improvement over traces that omit terminal state (`experience-prototypes/src/arcade.tsx:330`, `:357`, `:480`, `:596`).

`publication.json:35` points to `local-models-and-games/arcade/results.jsonl`. Filtering its actual contents to Snake gives six completed episode rows, three seeds and **496 executed actions**, evenly split between Jev and greedy code. Re-executing every recorded action reproduces all before-states and final states exactly.

| Seed | Jev food / moves / outcome | Greedy food / moves / outcome |
| --- | --- | --- |
| 7 | 9 / 90 / evaluation cutoff | 12 / 90 / evaluation cutoff |
| 19 | 12 / 90 / evaluation cutoff | 12 / 90 / evaluation cutoff |
| 42 | 10 / 68 / collision | 10 / 68 / collision |

The mean paired food difference is −1 for Jev. Jev selects the exact greedy action on **225/248 turns**. Every other nonfatal selection ties the greedy action on immediate safety and distance; there are **zero safe choices taking a longer immediate route**. Both controllers choose the same actions throughout seed 42. At its fatal state, all three next moves collide, so the last decision is not an avoidable immediate-safety mistake. Earlier choices created the trap. These data do not establish escape planning or an advantage over code. The existing README already states that limitation (`local-models-and-games/README.md:34`).

## What works

- One pure deterministic engine serves recording and the app. Unknown actions are rejected, terminal states stop advancing, and moving into a vacating tail cell is legal (`engine.ts:117`, `:187`). Existing tests pass: three tests, 125 assertions, including both arcade games.
- Food is placed only on empty cells and the PRNG state is explicit, which supports exact replay and future checkpoints (`engine.ts:34`, `:47`).
- Reset and unmount abort requests and increment an epoch, preventing an old answer from applying after those events (`arcade.tsx:339`, `:350`, `:399`).
- Manual play needs no model, replay has a terminal frame, the model observation is inspectable, and the UI explicitly calls these short demonstrations rather than a general game-playing benchmark (`arcade.tsx:657`, `:691`, `:719`).

## Findings

### 1. P1: The model controls the live game clock, and handoff discards the game

Live code waits for `run`, applies one move, then waits another 200ms before requesting the next move (`arcade.tsx:379`, `:414`, `:424`). Manual input advances a cell immediately and has no automatic movement clock (`:372`). A slow or unavailable provider therefore freezes the world. Selecting Play yourself or Run live calls `reset`, recreating `initial(game, seed)` and deleting the trace (`:339`, `:446`). There is no same-position handoff, checkpoint or branch.

Give the game an independent fixed-step clock. Model work can prepare a command for an identified future tick; it must never call the transition function when a response happens to arrive. A missed deadline executes an explicit recorded fallback at the original tick. Separate controller selection from new-game/reset. Preserve body, heading, food, RNG and score during takeover. This changes the interaction design, not merely the animation speed.

### 2. P1: The shared evaluation limit makes a full-game win unreachable

The snake starts at length three, wins only at length 100, and stops after 90 moves (`engine.ts:64`, `:204`, `:211`). Even eating on every move reaches length 93. Filling the board needs at least 97 growth moves, before accounting for travel. The same cutoff applies to manual and live play, so neither can reach the coded victory condition.

Move the 90-action limit into an evaluation wrapper. Classic play continues until collision, an actually reachable full-board win, explicit player pause or quit. Keep benchmark cutoffs distinct from gameplay loss and victory. Small practice boards can provide attainable victory sessions without rewriting the meaning of the original 10×10 evidence. Publish the rules version with every run.

### 3. P1: The recorded setup cannot identify a planning benefit

The model receives exact immediate safety and distance calculations, and all its safe recorded actions minimize that supplied distance. The greedy comparator uses those same numbers (`engine.ts:138`, `:238`). Only three seeds and one model trajectory per seed are recorded (`arcade/record.ts:20`). Seed 7 loses three food to greedy; the other pairs tie. Neither an ablation without previews nor a stronger escape-aware policy exists.

Keep the assistance visible. Compare raw geometry against geometry plus previews, retain greedy, and add a flood-fill/tail-aware controller and a verified Hamiltonian-cycle survival baseline. Lock new seeds before evaluation and assess delayed consequences with counterfactual branches, not the model's own probabilities. Food placement depends on occupied cells: at seed 7 the ninth food location differs between controllers even with the same PRNG seed. This is normal state-dependent environment behavior, but it means "same seeded start" does not guarantee the same subsequent food locations. Forking the exact same full state is necessary for a causal action comparison.

### 4. P1: Pause can still commit an in-flight move

Pause only toggles `playing` (`arcade.tsx:548`). The pending request's completion checks the reset epoch, not pause or an expected tick, then calls `setLocal(advance(current, ...))` (`:388`, `:399`, `:414`). A successful answer arriving after Pause therefore still advances the snake once. This is a source-level finding, not a claimed browser reproduction.

Have pause, takeover, branch restore and restart revoke pending commands through a controller epoch. Queue each response with session, branch, source-state hash and target tick. At the tick boundary, accept it at most once only if those conditions still match. A response must never overwrite the current state with a transition from its old captured state.

### 5. P2: Recorded latency is a shared service measurement, not live response time

The recorder batches Snake and Orbital questions, then copies `response.service_latency_ms`, batch size and total batch cost into every participating trace row (`record.ts:48`, `:64`). Snake's 248 decision rows have service median 313ms, p95 430ms and maximum 1,011ms, with batch sizes two through six. The browser labels these values Request time, while live rows use `r.latency_ms`, a different measurement (`arcade.tsx:410`, `:623`). Raw responses, request IDs and provider-failure attempts are not retained in the final record; retry messages only go to the console (`record.ts:89`). Do not sum copied batch costs or treat 248 decisions as 248 physical requests.

Persist one request ledger with wall/service times, retries, cost and participating decision IDs. Label replay service time separately. Report deadline-miss rate, fallback share and all-scheduled availability for the real-time game. These finite recordings cannot estimate them. The existing explicit fixed-clock replay caveat should remain.

## Richer interaction: Take the wheel, then fork the mistake

A player starts a keyless Classic game, steers continuously, and hands the current position to Jev. The clock keeps moving. A small controller badge distinguishes human, Jev and code fallback on each committed tick. The player can take over instantly. After a loss, a timeline offers the exact position before the trap; the player forks it and tries a different turn, while the original branch remains replayable. A comparison view can run a code controller from the same checkpoint.

The canonical game state contains rules version, board size, seed/PRNG state, body, heading, food, score and game tick. The session separately owns running/paused/terminal state, controller, branch ID, controller epoch, queued input, request deadline and a bounded event log. Store immutable checkpoints every food event and every 20 ticks, plus action/event deltas. Forking preserves the full game state and records a new lineage; pending network work from the parent is invalidated.

Start with a fixed 500ms logical step and a separately interpolated renderer. Human input queues one valid turn per tick. For Jev, request the next uncommitted tick's action from its exact source state. Apply an on-time response at that boundary; discard late answers. Missing answers use the declared fallback, initially continued heading or an explicitly enabled greedy safety controller. The fallback must be visible and counted. A 313ms batched service median does not prove that live wall time meets this deadline. Faster difficulties may be dominated by fallback; do not advertise that as Jev controlling every move. Provider rate limits also require a request budget independent of the clock. Longer queued plans or Jev-selected semantic goals are separate future controller designs, not claims supported by these one-action records.

Provider failure leaves the game running under its declared fallback or the player's control. Explicit user pause freezes it and revokes pending moves. Background suspension is a separately labeled pause, with no catch-up burst on return. Actual gameplay victory/loss ends the run; request or evaluation budget exhaustion merely disables assistance or suspends that evaluation. It does not kill a manual game.

Acceptance criteria:

- A keyless visitor can play, lose, restart, select a new seed and complete a small-board victory. Classic play can exceed 90 moves.
- Human/Jev handoff preserves the current game hash, apart from a recorded controller event, and never waits for a model response.
- With a hung request, an active virtual clock still executes exactly 20 ticks in ten seconds at the default rate, unless the game ends or the player pauses.
- Delayed, duplicate and out-of-order answers cannot advance paused games, revive terminal games, overwrite a fork or apply twice.
- Every tick records its actual controller and fallback reason. The UI never attributes a code fallback to Jev.
- Restoring a checkpoint and replaying its logged inputs reproduces every state hash. Forks do not change their parent's trace or score.
- Keyboard and touch use the same input queue; rendering and reduced-motion preferences cannot change game outcomes.

## Evaluation protocol

**Engine and interaction first.** Run 1,000 generated input/request schedules with zero, 100ms, 350ms, 800ms and 2.5s responses, hung calls, duplicates, takeover, pause, restart and branch restoration. Use a virtual clock and no provider. Require exact replay, no stale commits, no provider-induced tick suspension and a correctly exercised full-board victory. Test collision, growth and vacating-tail behavior separately. Existing tests are a good rules seed, but do not cover these lifecycle conditions.

**Policy comparison.** This is an original seeded environment, with no external benchmark split or official leaderboard scoring. Keep a clearly named 90-action comparison track separate from Classic play. Declare 20 development seeds and 100 disjoint held-out seeds. On the held-out seeds, compare three fresh Jev replicates in each of two observation tracks: geometry alone and geometry plus current action previews. Run safe random, existing greedy, flood-fill/tail-aware and verified Hamiltonian controllers on the same starts. Do not describe a model win rate when the 90-action wrapper makes board filling impossible.

That is 600 model episodes, with at most **54,000 logical action decisions before retries**, plus 400 local code episodes. Native batching can reduce physical calls, but the request ledger must supply the actual count. Start with a ten-seed, one-replicate development pilot in both observation tracks, at most 1,800 decisions; do not label it the held-out result. A spending or rate-limit stop retains an incomplete checkpoint rather than manufacturing a loss or silently dropping the run.

Primary outcomes are food at the declared horizon and collision-free survival to it. Also report time-to-collision, no-safe-action trap rate, food per move, loops, model/code fallback fractions, wall latency, deadline misses, physical requests and cost. Outcome code, not Jev, computes them. Use 10,000 paired bootstrap resamples clustered by seed, keeping policies, observation tracks and replicates together. Report mean paired food and survival differences with 95% intervals. Superiority requires the preregistered interval above zero against the escape-aware comparator, not merely random. Never treat individual actions as independent samples.

**Delayed consequences.** Freeze 200 additional unique checkpoint states generated by code policies from disjoint seeds, including near-traps. For each, execute all three candidate first actions and then the same fixed, independently implemented continuation policy for 20 ticks. Compare survival and food across those branches. This is a specified continuation test, not an optimal-planning oracle. Three model replicates in both observation tracks add at most **1,200 decisions**. These states test whether a chosen turn preserves a later exit rather than merely matching a supplied one-step minimum. Lock the states before inspecting Jev choices.

**Playable real-time behavior.** Separately test 100 seeds with the declared deadline and fallback policy, capped at 50 model decisions per run, at most 5,000 calls. Pair live-delay traces with synthetic-delay controls, and keep accepted Jev moves, missed deadlines and fallback outcomes separate. Do not reuse the finite benchmark's service latency as a simulation of complete live latency. A small counterbalanced 24-player study, four unique runs each, can compare manual play with optional handoff, measuring score, elapsed play, takeovers and whether checkpoint recovery was useful. Cap the 48 assisted runs at 50 model decisions each, at most 2,400 calls; assistance then yields to the declared fallback or player without ending the game. Budget and a working prototype are future prerequisites; none of these new model runs or human studies occurred in this audit.

## Useful libraries and next steps

[Phaser's scene clock](https://docs.phaser.io/phaser/concepts/time) and [input system](https://docs.phaser.io/phaser/concepts/input) can coordinate timed movement, rendering and keyboard/touch input for a richer game. Keep the pure rules and an explicit fixed-step accumulator outside request callbacks. Phaser is optional; the existing SVG renderer can support the first version. Jev supplies a declared controller, not the clock.

[XState actors](https://stately.ai/docs/actors) and [persistence](https://stately.ai/docs/persistence) can make running, paused, waiting-for-decision and controller transitions explicit, and serialize the session state used by checkpoint tooling. Persist deterministic game data; do not restore an old in-flight promise as if it were a valid decision. Branch validation remains application logic.

| Priority | Size | Work |
| --- | --- | --- |
| P1 | S | Separate the 90-action evaluation wrapper from Classic rules; correct unreachable-win behavior. |
| P1 | M | Add an independent clock, tick queue, explicit fallback, controller epochs and pause cancellation. |
| P1 | M | Preserve the same position during handoff; add immutable checkpoints, exact restore and branch replay. |
| P1 | M | Add escape-aware baselines, the preview ablation and locked seed/checkpoint manifests. |
| P2 | S | Add a physical-request ledger and distinguish wall/service latency and provider interruptions. |
| P2 | M | Test semantic goal selection or queued plans as a separately labeled hybrid controller. |

The deterministic checkpoint and command-deadline work can later support Orbital rescue and other real-time game experiments. It should not silently alter their existing finite recorded comparisons.

## Investigation log

Read the current catalog, `Arcade`, shared engine, recorder, publication mapping, tests and local README. Confirmed those Snake sources match `4c0c40d`. Decoded all six Snake episodes, re-executed all 496 actions, checked safety/greedy agreement, compared food sequences, calculated service-latency quantiles and proved the win-cap contradiction. Ran the existing three engine tests, all 125 assertions passing. Verified the two optional libraries against current primary documentation. No paid calls, app changes or browser tests were made. Reproduce the evidence with `bun run quality-and-simulation-review/probes/snake.ts` from `jev-experiments/`.
