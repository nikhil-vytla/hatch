# Key & door

Verdict: **redesign**. Highest priority: **P1**. Keep the recorded comparison as evidence, but add a complete game with manual control and Jev handoff. The current route is a replay viewer, and its 64-action lab cutoff is neither a complete playable session nor the environments' native timeout. Findings describe the source hashes captured in `probes/games.json`.

## Current purpose and evidence

The catalog asks whether remembering what happened helps an agent navigate (`experience-prototypes/src/catalog.ts:62`). `Games` lets the visitor choose a policy, environment, seed, and playback speed, then scrub or replay recorded actions (`experience-prototypes/src/games.tsx:66`). It makes no live request and has no manual movement, game engine, handoff, new maze, or actual restart. “Restart” rewinds the trace. The interface does correctly call these recorded MiniGrid actions (`games.tsx:174`).

In the runner, Jev chooses one allowed primitive action. Code generates the MiniGrid world, converts the partial symbolic observation into text labels, supplies inventory and an action mask, executes movement, and calculates rewards (`src/jev_lab/games.py:12`, `:15`, `:147`). Jev sees no hidden map or absolute position. The memory condition receives the last eight actions with the front cell and inventory **before** each action; it does not receive a persistent map or learned memory (`games.py:101`, `:159`). Visible BFS searches the current partial grid using exact geometry; random chooses uniformly from the same mask. All policies get the same current observation, but only the memory condition gets that explicit history.

The publication mapping points to `results/games.jsonl`. Decoding the entire record with `readRecord` gives **240 episode rows, 7,933 trace rows, and 129 interned observations**. There are 156 wins, 83 lab cutoffs, and one HTTP 429 interruption after 22 actual actions. The interrupted row reports 23 steps because it includes the error row.

| Environment | Policy | Wins / scheduled | Lab cutoffs | Interrupted | Mean actions, non-interrupted runs |
| --- | --- | --- | --- | --- | --- |
| Empty 5×5 | Random | 21 / 30 | 9 | 0 | 42.17 |
| Empty 5×5 | Visible BFS | 30 / 30 | 0 | 0 | 5.00 |
| Empty 5×5 | Jev reactive | 0 / 30 | 30 | 0 | 64.00 |
| Empty 5×5 | Jev + eight recent actions | 30 / 30 | 0 | 0 | 12.00 |
| DoorKey 5×5 | Random | 2 / 30 | 28 | 0 | 63.47 |
| DoorKey 5×5 | Visible BFS | 30 / 30 | 0 | 0 | 10.50 |
| DoorKey 5×5 | Jev reactive | 14 / 30 | 16 | 0 | 38.07 |
| DoorKey 5×5 | Jev + eight recent actions | 29 / 30 | 0 | 1 | 29.45 |

The geometric baseline is better on the recorded tasks. Recent actions break Jev's repeated behavior on the fixed empty room and improve observed DoorKey results, but these records do not establish general planning ability or fresh-request reliability across 30 independent worlds.

## What works

- This is actual MiniGrid execution, with environment reward, per-action latency/cache flags, and the agent's partial observations retained. The runner checks that the selected action belongs to the offered contract (`games.py:145`).
- The BFS comparator receives the same visible geometry rather than a privileged full map (`games.py:48`). Retaining this strong comparator is useful even when it beats the model.
- Observation interning is lossless and has an existing round-trip test; a second test verifies exact-observation cache reuse (`src/jev_lab/reporting.py:10`; `tests/test_contracts.py:14`, `:38`). These tests do not cover a playable lifecycle or terminal replay.
- The result note and README explicitly disclose caching, the 64-step limit, repeated empty-room layout, and the better geometric baseline (`games.py:267`; `README.md:58`). The UI excludes the interrupted row from ordinary playback and says that it remains in downloadable evidence (`games.tsx:236`).

## Findings

### 1. P1: There is no complete playable game

Every control changes replay selection or the trace index (`games.tsx:124`). There is no environment transition function in the route. A visitor cannot make a move, hand a live position to Jev, take control back, lose a game, restart its state, or continue to another maze. This matches the existing “Watch” copy, but it does not satisfy the requested full-game experience.

Build a complete local maze engine and manual game first, then connect Jev to the same action dispatcher. Use distinct Play, Recorded runs, and Compare modes. Play must remain usable without an API key. A provider failure should pause the assistant and return control, not finish the game or silently advance a recorded trace. The design below includes actual win/loss and restart behavior.

### 2. P1: The records omit terminal state and conflate different stopping conditions

The runner captures `state` before `env.step`, stores the reward afterward, and never stores the next observation or `terminated`/`truncated` flags (`games.py:147`). All 156 successful traces end with a `forward` action and positive reward while the displayed observation still has the goal in front. The callback probe confirms this for the default replay. None of the 240 rows has an explicit termination field, and 83 unsuccessful rows simply exhaust the outer `range(64)` loop.

Installed MiniGrid 3.1.0 and its official source use 100 native steps for Empty 5×5 and 250 for DoorKey 5×5. The lab stops before those limits. Native success gives `1 - 0.9 × step_count / max_steps`; the 64-action wrapper does not change that reward denominator. These are modified experiments, not native-timeout results. [Empty source](https://raw.githubusercontent.com/Farama-Foundation/Minigrid/v3.1.0/minigrid/envs/empty.py), [DoorKey source](https://raw.githubusercontent.com/Farama-Foundation/Minigrid/v3.1.0/minigrid/envs/doorkey.py).

Persist initial state plus every action's resulting state, reward, and explicit stop reason: goal, environment timeout, gameplay loss, lab cutoff, provider interruption, or user stop. Count executed actions separately from error events. Replay the final transition and show the terminal board. Report the memory result as 29 wins from 30 scheduled runs, with 29/29 wins among completed runs and one interruption; the conditional rate must never replace end-to-end availability. Gymnasium explicitly distinguishes termination from truncation. [Env API](https://gymnasium.farama.org/api/env/).

### 3. P1: Layout repetition and shared decisions limit the memory comparison

All 30 Empty seeds have the same initial observation; each deterministic policy has one repeated action trace. The non-random Empty configuration fixes the start and goal. DoorKey has 20 distinct initial observations among the 30 seeds; that count is not proof of only 20 full worlds because observations are partial. Jev uses cached results on **3,886 of 4,298 action rows (90.4%)**. Its 419 published memoized request states are shared across episodes, and requests with empty history can also be shared between reactive and memory policies (`games.py:113`, `:193`).

This is a cached-policy comparison over a small environment family. It cannot estimate fresh model variability or support a confidence interval treating all rows as independent samples. The README already states much of this limit, but the comparison needs a stronger design before expanding its claim. Keep the fixed Empty room as one diagnostic control. Use held-out generated layouts, explicit policy information tables, model request IDs, and declared cache modes. Compare recent-action memory with both reactive Jev and a persistent-map code planner. Show fresh-call latency separately from cached replay; current transport statistics cover the resumed run, whereas the evidence includes earlier runs.

### 4. P1: The wrapper assists the agents and renames a toggle as an opening action

Native MiniGrid exposes seven actions and a symbolic partial observation plus direction and mission. This wrapper removes drop/done, masks blocked forward and inappropriate pickup actions, translates cells to names, and exposes inventory. These are useful aids shared by the compared policies, but they make the test an assisted MiniGrid protocol. It is not a vision benchmark or an unmodified seven-action benchmark. [DoorKey documentation](https://minigrid.farama.org/environments/minigrid/DoorKeyEnv/).

`open_door` maps to native action 5, which toggles a door (`games.py:12`). It remains offered for an already open door or a locked door without the key (`games.py:37`). In the records, random executes this misleadingly named action on an open door ten times, closing it, and without a key 20 times, making no progress. These are allowed actions, so the mask should not be described as guaranteeing productive moves. The recorded Jev rows do not exhibit those particular cases.

Use accurate names and state transitions: `toggle_door`, or a custom `open` action with explicitly different semantics. Version the wrapper and publish its observation/action assistance. Keep a literal MiniGrid condition with native actions and limits separate from an assisted condition. Give all policies the same assistance within each comparison, and preserve full-map oracles only as labeled ceilings.

### 5. P2: The replay hides the details needed to understand the decisions

`GameGrid` assigns every door the same class and closed-door icon, regardless of open/closed/locked state or color (`games.tsx:34`, `:55`). Actual rendered element trees are identical for locked versus open doors and yellow versus red doors in the offline probe. Current worlds use yellow doors, so color is a future extensibility issue; open versus locked already matters today. “Inspect the agent's observation” shows the base observation and action row, but not the `recent_actions` supplied to the memory policy (`games.tsx:241`; `games.py:103`).

Draw door status distinctly, expose inventory and action consequences, and show the exact request observation including the eight history items. Distinguish the observation before a decision from its resulting frame. For play, provide visible keyboard/touch controls, focus handling, and a concise state announcement so the task is understandable beyond the animated grid.

## Complete game: a three-room key maze

The visitor starts a seedable three-level maze campaign. Each level has corridors, a matching key and locked door, optional extra treasure, hazards, and an exit. The player turns, advances, picks up/drops an object, and toggles a door using keyboard or touch controls. Fog reveals only observed cells. A visible three-heart meter supplies an actual loss condition: entering a hazard costs one heart and returns the player to that level's entrance while preserving collected items and opened doors. Zero hearts ends the attempt; reaching the final exit wins the campaign. Level restart resets its layout, items, doors, and health from the selected seed. New game chooses a new seed. These are custom game rules and must not be labeled official MiniGrid results.

After making a few moves, the player can choose “Jev: take over” or request one suggested move. Jev receives only the current observation and the allowed history/map mode, then chooses from the same action contract as the player. The interface identifies the controller and pending move. Manual input or “Take control” invalidates a pending request immediately; late answers cannot move the new state. The player can finish manually if the key is absent, the service fails, or the assistant budget is exhausted. Pausing prevents input and model dispatch until resumed. The world advances by actions, not model latency or animation time.

State is a serializable level/campaign seed, map and object state, pose, inventory, hearts, turn count, fog/history, controller, lifecycle status, and revision. A pure transition function applies every human, code-policy, and Jev action. Rendering reads that state. Jev never writes the map, teleports the player, awards a win, or changes the rules. A separate evaluation adapter emits the restricted observation; privileged map data stays out of model requests. If a later hybrid uses BFS to execute a semantic goal selected by Jev, label the hybrid and measure its division of work explicitly.

Recorded runs remain watchable. Compare runs an independent clone of a declared seed for each policy and continues to the game's real terminal outcome. It does not mutate the current campaign or turn a display/request cap into a loss. A request budget can suspend an evaluation with an explicit incomplete status and resumable checkpoint.

Acceptance criteria:

- A keyless browser can start, play, win or lose, restart the same level, and start a new campaign; touch and keyboard controls exercise the same transitions.
- Keys, matching locks, open-door passage, hazards, respawn, lives, exit progression, and final victory obey the documented rules and expose their effects.
- Each action changes state at most once. Human takeover, restart, seed change, or game over prevents any pending answer from applying.
- The assistant sees only its declared information. A spectator full-map view is labeled and does not change the observation adapter.
- Replaying a seed and action list reproduces every state hash and terminal result. The final board is visible, and restart resets all relevant state.
- Game outcomes, provider interruptions, comparison budget suspensions, and user stops remain distinct. Every active manual game can continue without a provider.

## Evaluation protocol

**Game quality first.** Generate 100 seeds in each of three maze difficulty tiers and independently validate reachability, key/door order, and hazard avoidance with an oracle. Run four code policies on all 300 layouts, giving 1,200 complete local episodes. Add 1,000 generated control schedules covering handoff, delayed results, restart, pause, loss, and campaign progression. Release requires zero accepted stale actions or contradictory terminal states, exact deterministic replay, and a demonstrated manual win, loss, restart, and handoff on desktop and touch. No model requests are needed for these checks.

**Literal environment comparison.** MiniGrid is a procedural environment suite, not a fixed test dataset with an official finite split. Official documentation lists four DoorKey sizes (5, 6, 8, 16) and six Empty configurations. Current coverage is one size from each family, 30 seed labels each, with only one fixed Empty layout and a modified wrapper. No fraction of “the full MiniGrid benchmark” is justified. [DoorKey configurations](https://minigrid.farama.org/environments/minigrid/DoorKeyEnv/), [Empty configurations](https://minigrid.farama.org/environments/minigrid/EmptyEnv/).

Define a versioned local test manifest of **30 held-out seeds per DoorKey size: 120 environment/seed pairs**. Keep development seeds disjoint and deduplicate full initial-state hashes for analysis. Run six policies: random, current visible BFS, a persistent observed-map frontier planner, reactive Jev, Jev with eight recent actions, and a privileged full-map shortest-path oracle. The oracle is a ceiling, not an equal-information competitor. Use two separately reported tracks: native seven-action MiniGrid with native limits, and the documented text/inventory/action-mask assistance. Keep information identical across competing policies within a track except for the declared memory ablation. Log the compass direction decision explicitly because the current wrapper omits it.

This produces **1,440 policy episodes**, including **480 Jev episodes**. Native DoorKey limits for sizes 5/6/8/16 are 250/360/640/2,560. Two Jev policies across two tracks and 30 seeds therefore have a worst-case ceiling of **457,200 logical action requests before retries**. That is a substantial future budget requirement, not a recommendation to launch it now. A first five-seed, 5×5-only pilot across the two policies and two tracks is 20 Jev episodes, at most 5,000 requests; it is a development pilot, not the full planned result. Provider spending limits suspend runs with resumable state. They must not shorten the rules silently or count unavailable episodes as behavioral losses.

Native score is the environment's successful terminal reward, otherwise zero; report mean return and goal rate separately. Preserve native termination/truncation and limits. Report all-scheduled completion, provider interruption, action count, loop/no-progress rate, repeated toggles, success-conditioned path length, and latency/cost. Use the oracle only to calculate a labeled path-efficiency ceiling. Fresh-call mode disables cross-episode decision caching. A separate cache-enabled system test measures cost and response time without presenting cached episodes as new model samples.

Estimate paired policy differences using 10,000 bootstrap resamples clustered by unique generated layout, retaining policy/assistance pairs together, and stratify by size. A claim that recent actions improve goal success requires the 95% paired interval above zero; otherwise report the observed difference and uncertainty. A claim that Jev beats code requires superiority to the persistent-map planner, not merely random play. Publish unavailable outcomes and sensitivity bounds rather than silently selecting only completed pairs. Current results do not meet either new protocol's evidential requirements.

**Value of handoff.** Run a separate counterbalanced study with 24 players completing four distinct mazes each, two manual and two with optional Jev handoff: 96 complete games. No player repeats a map. Measure finish rate, elapsed time, wrong-door/hazard actions, takeovers, and whether assistance preserved the intended state. Cap assistance at 50 model decisions per assisted game, returning control at that point without ending play: at most **2,400 additional requests**. Analyze within-player differences with uncertainty; log actual assistant use. This is a human assistance study, not an autonomous-agent benchmark.

No proposed model calls, new environment episodes, or user study were run in this audit. The large comparison needs future budget, versioned environment/wrapper manifests, terminal-complete logging, and independent test seeds. It needs no large dataset or model-weight download.

## Useful existing libraries

- [MiniGrid](https://minigrid.farama.org/environments/minigrid/DoorKeyEnv/), already installed as 3.1.0 locally: retain the authoritative Python environment for literal benchmark rules and seeded reference trajectories. A browser port needs state-transition parity checks before sharing the MiniGrid name or scores. Jev supplies a policy; MiniGrid supplies the game rules.
- [Phaser scenes](https://docs.phaser.io/phaser/concepts/scenes) and [input](https://docs.phaser.io/phaser/concepts/input): useful for the separate playable campaign's scene lifecycle, keyboard/touch controls, and animation. Keep the pure turn-based engine independent of Phaser so rendering speed cannot change results. The current React grid can also support a small first version; a framework switch is optional.
- [Gymnasium Env API](https://gymnasium.farama.org/api/env/): preserve explicit reset, transition, reward, termination, and truncation in the comparison adapter. It prevents the current error of treating a stopped trace as a fully described game outcome. Jev's role remains one declared controller of those transitions.

## Prioritized work

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Correct outcome categories, action counts, toggle naming, and assisted-protocol labels. |
| P1 | M | Record resulting observations and termination flags; replay terminal state and expose exact memory inputs. |
| P1 | L | Build the complete manual maze campaign, deterministic engine, win/loss, restart, and seed controls. |
| P1 | M | Add Jev suggestion/handoff through that engine with cancellation and revision checks. |
| P1 | M | Separate comparison mode, information-matched baselines, disjoint seeds, and native versus assisted tracks; start with the declared pilot. |
| P2 | S | Render door status and inventory clearly and verify keyboard/touch state feedback. |

The same engine and observation adapter can later test semantic missions such as retrieving a named object while avoiding a specified hazard. That is a useful extension for Jev once the full game and geometric baseline are dependable.

## Investigation log

Read the catalog, Games/GameGrid components, Python runner and prompts, publication mapping, lossless record encoder, all decoded episodes, existing game-related contract tests, installed MiniGrid 3.1.0 environment/action/door code, and current reporting notes. Ran `bun jev-experiments/quality-and-simulation-review/probes/games.ts` to count outcomes, repeated observations/traces, cache use, toggle cases, and terminal fields. The same probe executes actual React functions with mocked hooks/elements, confirming identical door element trees and a pre-goal final display. It captures source hashes and results in `probes/games.json`. This is an offline audit, not browser testing or fresh MiniGrid/model execution. Verified native action spaces, configuration counts, reward rules, default limits, and proposed libraries against the linked primary sources. Only assigned reports and the original probe were written.
