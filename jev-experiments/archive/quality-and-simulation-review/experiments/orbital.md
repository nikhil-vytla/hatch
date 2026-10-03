# Orbital rescue

Verdict: redesign. Highest priority: P1. This review covers original main `4c0c40d5`. The engine, recorder, published record and React component still match that commit. The separate real-time prototype under development does not change these findings.

## What it currently demonstrates

Jev chooses one of six absolute directions from a complete symbolic description of a small 3D grid. Code chooses the nearest remaining core, supplies every candidate's next position, collision flag and distance to that objective, then applies the selected move. Jev does not see the rendered image. Three cores, five hazard entries and a return to `(0,2,0)` form one mission. Hull damage and a 70-action oxygen budget end unsuccessful missions. See `local-models-and-games/arcade/engine.ts:72`, `:153`, `:215` and `:248`, with paths relative to `jev-experiments` throughout.

The visitor can watch recorded Jev or greedy runs, inspect probabilities and structured observations, start a live request, or fly manually. Three.js renders a perspective scene with an orbit camera. There is a genuine reachable win, a loss, a restart and a final replay frame. There is no campaign, checkpoint branch or transfer between controllers at the current state.

## What works

- The deterministic engine and complete before-action states make the evidence inspectable. Replaying all 192 recorded Orbital transitions reproduces every state and final outcome exactly. Unknown actions throw; terminal states stop advancing. Source: `engine.ts:187`.
- All three seeds have completed Jev and greedy episodes with the same initial state. Both policies collect all cores, return home and retain full hull. The recorder and UI explicitly describe fixed-clock demonstration playback, so the replay speed is not itself a deceptive latency claim. Source: `record.ts:110`; `experience-prototypes/src/arcade.tsx:691` and `:719`.
- The UI exposes the actual observation, direct manual controls, replay scrubbing and controller comparison. Reset and unmount abort requests and invalidate their generation. The renderer disposes its resources, catches WebGL creation failure and respects reduced motion for its decorative animation. Source: `arcade.tsx:109`, `:259`, `:285`, `:339`, `:596` and `:657`.

## Findings

### P1: the recorded coverage never tests immediate hazard avoidance

The complete published set contains six episodes on seeds 7, 19 and 42, with 96 Jev actions and 96 greedy actions. At every visited state, all six immediate alternatives are in bounds and hazard-free. Jev matches the exact greedy choice on 95 of 96 actions, and every selected move minimizes the supplied distance among safe moves. This demonstrates correct use of supplied geometry on easy trajectories; it provides no observed collision-avoidance decision and little evidence of planning beyond the helper.

| Seed | Jev moves | Greedy moves | Exact shortest no-damage mission | Jev matches greedy |
| --- | ---: | ---: | ---: | ---: |
| 7 | 42 | 42 | 42 | 42/42 |
| 19 | 24 | 24 | 24 | 24/24 |
| 42 | 30 | 30 | 26 | 29/30 |

The independent breadth-first search tracks position and collected-core mask. Its routes also win in the actual engine. A separate code-only sweep of seeds 0 through 999 gives greedy 1,000 wins; it is not additional Jev coverage. Hazard generation permits repeated coordinates, and 26 of those 1,000 seeds have fewer than five distinct hazards. Source: `engine.ts:86`, `:153`, `:238`; [probe results](../probes/orbital.json).

A crafted mid-mission state makes the missing challenge concrete. One core at `(3,2,0)` and hazards at `(1,2,0)` and `(1,3,0)` make greedy alternate up/down until timeout. A safe 10-move route collects the core and returns home. This is a baseline counterexample, not a measured Jev failure. Add solvable forced-detour and core-ordering cases, enforce distinct hazards, and report observation assistance as an experimental condition. Keep a geometry-only condition separate from the current nearest-objective previews.

### P1: the live world advances only when the model answers

The existing RAF loop interpolates the drone and animates decorative objects; it never advances mission state. `tick()` awaits the model and then calls `advance(current, answer)`. The next request starts only after that completes plus a 200 ms timeout. Manual mode advances only on input. Source: `arcade.tsx:261`, `:372`, `:379`, `:414` and `:424`.

A slow request therefore stops the mission clock, position and hazards. This is consistent with a turn-based benchmark but does not meet the requested real-time play experience. Mode buttons call `reset(id)`, discarding the current run. Pause only changes `playing`; an already pending answer still applies because the acceptance guard checks the generation, which Pause does not change. Source: `arcade.tsx:339`, `:399`, `:446` and `:548`. These are source-level lifecycle findings, not browser reproductions.

Use an independent fixed simulation clock and explicit controller ownership. Accept bounded Jev intents against a state revision and deadline; execute them through code. A late response should expire while the last valid flight plan or declared hold behavior continues. Human takeover must retain position, cargo, hull, clock and hazard phase, invalidate pending decisions, and take effect by the next simulation tick. A deliberate game Pause should suspend the world and invalidate pending work. Pausing model control alone should leave the world running and display its fallback controller.

### P2: the visible dock and manual navigation hide decisive coordinates

The beacon ring is at `(0,0.05,0)`, while the winning position is exactly `(0,2,0)`. A faint beam reaches altitude 2, but no docking marker identifies its top. The probe confirms that an otherwise completed mission at `(0,0,0)` remains playing and wins only after climbing two cells. Source: `arcade.tsx:159`, `:170`; `engine.ts:228`.

The orbit camera can turn freely while arrows retain world-axis directions. The main HUD gives neither compass nor drone/target altitude; the raw inspector contains coordinates, so this is an avoidable navigation burden rather than an impossible game. Source: `arcade.tsx:127`, `:492`, `:507`, `:615`. Put a labeled dock target at the actual winning altitude, show a world-axis compass and current/target altitude, and offer a top-down inset. Define whether controls follow the camera or world and display that choice.

Collision is also a grid abstraction: damage checks the next center's distance below 0.8, not the visible rotor geometry or a swept flight path. Source: `engine.ts:221`; `arcade.tsx:183`, `:196`, `:225`. Render the collision proxy and cell occupancy for the existing benchmark. If a new continuous-flight version adds actual colliders, version its rules and test that the visible body and collision body agree.

### P2: mission oxygen, evaluation budget and progression are conflated

`moves_left` is 70 minus action count. The timeout says oxygen is exhausted, but waiting indefinitely costs none. The main HUD shows elapsed moves without the remaining budget. Source: `engine.ts:164`, `:231`; `arcade.tsx:507`. A 70-move fuel rule is valid and the published missions can finish within it; it should be presented as that rule. It should not become a hidden benchmark cap in a purported ongoing game.

Preserve the original finite mission as a versioned evaluation. For play, choose and show a real mission resource, such as oxygen consumed per simulation second or maneuver fuel consumed per action. Keep evaluation truncation separate from in-world defeat. Add a short sequence of missions with onboarding, a new obstacle pattern, a return-and-repair phase and a campaign result. Three selectable seeds plus restart currently provide replay variety, not progression.

### P2: recorded request time is shared service latency

The recorder copies one batch's `service_latency_ms` and total `cost_usd` into each pending game's action. The UI calls this value "Request time", while live rows use their request timing. Source: `record.ts:50`, `:71`; `arcade.tsx:406`, `:623`. The 96 Orbital entries have median service latency 318 ms, p95 428 ms and maximum 1,011 ms, but these are neither 96 independent physical-request samples nor end-to-end control delays. The final record lacks request IDs and failed-attempt rows; exact physical request count and retry cost cannot be recovered from it.

Label the legacy values "batch service latency". Record each physical request once with a request ID, monotonic start/end, queue/service timing if available, retry outcome and cost. Link each decision to that request and log the simulation tick on which it became eligible and was applied or rejected. Do not sum copied batch cost across actions or combine provider failures with gameplay mistakes.

## Proposed simulation: a rescue sortie with shared controls

The visitor flies a short training rescue, docks to repair, and launches a second mission with an obstructed corridor. A third mission adds moving hazards and a time-sensitive core. Each mission has a briefing, clear objective, reachable ending and a recovery choice after loss. The first mission teaches the altitude and docking controls directly in the scene.

Keep the original grid benchmark available separately. In the proposed continuous-flight game, deterministic code owns the fixed world tick, position and velocity, collision volumes, oxygen, core collection, docking speed/volume checks, hazards and mission progression. Jev chooses a typed goal such as `recover(coreId)`, `returnToDock` or `hold(zoneId)` from current legal targets, informed by the user's instruction and explicit mission priorities. A code planner executes the goal safely and replans around moving obstacles. This changes the model's job and must be labeled as such; it cannot inherit six-direction benchmark scores.

The player can take the controls at any instant, ask Jev to finish the rescue, or restore a checkpoint and try another route. Immutable checkpoints include rules version, seed/RNG state, simulation tick, velocity, cargo, hull, oxygen, hazard phase and mission progress. Controller generation changes on restore or takeover. Each branch keeps its own action history and provider record. A failed or late request leaves a visible code fallback in charge. The world continues consuming mission time, so fallback can still lose a mission.

Acceptance criteria:

- With an injected five-second provider delay, the world advances exactly as it does without a response. Hazards move, oxygen changes and the controller badge identifies fallback. No response applies after its deadline or to a restored branch.
- Manual-to-Jev and Jev-to-manual transfers preserve canonical mission state. Manual intent controls the next simulation tick. A delayed old response cannot reclaim control.
- Every campaign mission has an independently verified reachable win; fuel/oxygen loss and hull loss are distinct. An evaluation cutoff produces `truncated`, not an invented in-world defeat.
- A checkpoint replay reproduces canonical state hashes; different branches keep separate decisions. Restoring a checkpoint neither replays a network side effect nor reuses an outstanding request.
- The dock marker, collision proxy, compass and altitude displays match code coordinates. Keyboard and touch controls support every direction without requiring the inspector. Reduced motion removes decoration while preserving navigation information.
- All three missions are playable manually through the campaign result. Model assistance improves a declared objective, such as honoring urgency, rather than replacing a route solver with model calls for arithmetic.

## Evaluation protocol

Current evidence is an authored three-seed demonstration with three paired outcomes, not an external benchmark or a vision test. Both controllers win 3/3. The 1,000-seed greedy sweep and crafted detour above are new code-only audit probes. They must remain outside the published Jev denominator.

For the frozen grid task, author 20 development worlds and freeze 150 test worlds, 50 each for easy collection, forced detours and competing core orders. Require distinct hazards and verify solvability with the independent position/core-mask search. Include boundary, low-hull and return-to-dock states in the authored suite. Publish the generator, seed list, goal definition and per-stratum admission tests before running Jev. This is a full declared authored set; there is no external split or official score to borrow.

Run each test world three times under two observation conditions: complete geometry alone, and complete geometry plus the current selected objective and action previews. This is 900 Jev episodes, at most 63,000 logical decisions under the legacy 70-action limit, with physical request count recorded separately. Compare random-safe, current greedy, shortest-path-to-nearest-core, and exact no-damage collect-all-and-return search. Code baselines use all 150 worlds and cost no provider calls. The exact search has at most 1,014 positions times eight core masks for the existing rules, so this baseline is practical. It optimizes no-damage missions; report that constraint when comparing policies allowed to trade hull for a shorter route.

Score mission completion independently from the engine's claimed status, cores returned, remaining hull, collision and boundary count, action count, excess moves over the constrained oracle, repeated-state loops and route length. Report win count and total cases, per-stratum results, paired differences and seed-clustered bootstrap intervals. Treat repeated decisions from one trajectory as dependent. Balance option order and freeze helper, prompt, engine and model versions. Seeds already viewed during development stay out of the test set. Label provider errors, retries and incomplete episodes separately and retain their denominators.

For real-time play, first run 1,000 local schedules combining delayed/out-of-order responses, takeover, pause and checkpoint restore. Require zero stale applications and exact clock/state invariants. Then compare manual, code autopilot and Jev-goal-plus-code control over 30 held-out three-mission campaigns, three Jev repeats per campaign. Cap the Jev condition at 20 goal decisions per mission, at most 5,400 logical decisions. Use the same seeded hazard schedules. Report full campaign completion, rescue priority adherence, mission time, hull/oxygen, time on fallback, deadline misses and takeover latency. These results measure a different controller architecture and need a separate table. A small counterbalanced usability study can check whether people can navigate and dock without the inspector; it cannot establish general agent superiority.

## Useful libraries

- [Three.js OrbitControls](https://threejs.org/docs/pages/OrbitControls.html) is already present. Its camera angles and reset/save controls can drive a compass and a reliable return to the training view. Jev's role remains mission choice; this library makes human control and inspection legible.
- [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/) provide ray and shape casts for a future continuous-flight controller. Use a swept shape to validate a bounded movement segment and render the same collider. The current integer-grid benchmark does not need a physics dependency.
- [XState persistence](https://stately.ai/docs/persistence) can represent mission/control phases and persist their state alongside the deterministic world snapshot. Restore with a new request generation; persistence itself does not cancel outstanding network work. Jev supplies bounded goal events, while the state machine governs their authority.

## Next steps

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Publish the six-episode coverage counts, zero hazardous-choice coverage and helper boundary; preserve the original records. |
| P1 | M | Add the independent oracle, forced-detour worlds, unique-hazard generation and frozen two-condition evaluation. |
| P1 | L | Build the independent world clock, same-state controller transfer, deadline fallback and checkpoint branches for a versioned play mode. |
| P2 | S | Align the docking marker with its actual target, add altitude/compass/budget displays, and distinguish service latency from request time. |
| P2 | M | Add a three-mission progression and test navigation, collision and docking through complete manual sessions. |

The checkpoint and controller work can support a later rescue-dispatch experiment in which Jev interprets changing mission priorities while a conventional planner handles flight.

## Investigation log

Read the catalog, publication mapping, full Orbital engine/prompt, recorder, decoded published episodes, shared React component and engine tests. Verified the four audited source/data files have no diff from `4c0c40d5`; the probe preserves SHA-256 hashes. Wrote and ran [the original Bun probe](../probes/orbital.ts), reproduced all 192 transitions, calculated the three constrained optima, tested the detour and docking states, and ran the 1,000-seed code-only sweep. `bun test jev-experiments/local-models-and-games/arcade/engine.test.ts` passed three tests and 125 assertions. Verified the three library links against primary documentation. No browser interaction, model call, app edit or commit was performed for this audit.
