# Live Tetris

A complete, continuously running Tetris variant now powers the primary Tetris experience. Two lanes advance on one 20ms simulation clock while their requests run independently. Both can use the same Jev formulation with assistance enabled in one lane and disabled in the other. The default uses local code and artificial delay; no new Jev performance claim follows from its line clears.

## Play and compare

The game has a 10×20 board, deterministic seven-bag pieces, movement, two rotation directions, simple wall/floor kicks, ghost landings, hold once per piece, next previews, 450ms lock delay, scoring, speed progression, top-out and restart. Play has no step or piece horizon. Rotation is an explicitly simplified variant, not official SRS; there are no T-spin bonuses or multiplayer garbage. Line clears score 100/300/500/800 times the current level, and each ten lines increases the level.

Each lane exposes three formulations:

| Formulation | Decision authority | Host code |
| --- | --- | --- |
| Short buttons | Left/right/down for 240ms, one rotation or hard drop | Collision checks and gravity; answers expire after 300ms world time |
| Reachable landing | One currently reachable final placement | Enumerates reachable routes and computed outcomes, then executes the chosen route |
| Planner intent | Clear lines, keep low or avoid holes | Chooses the actual landing using the selected objective |

Landing options expose cleared lines, buried empty cells, highest and total column height, unevenness, top-out and required inputs. These formulations differ in information and code assistance. They are not a controlled wording-only comparison. A landed target is rechecked against the current moving piece; its route is regenerated from the current position.

Unassisted play continues a still-valid command or route, then gravity alone. Assisted play chooses a new landing with a deterministic planner when needed. The user chose a short grace period before fallback as the default policy. Its visible **Wait before choosing fallback** control ranges from 0 to 2400ms, with an initial 700ms default. The wait starts when each new piece spawns, including the gap before its next request. Gravity keeps running, and a still-valid plan continues. Changing only this wait preserves the current request and plan. Zero preserves immediate fallback; longer waits give replies more opportunity to act but leave more time to gravity. Replies can still become stale.

The explicit **Local slow-reply demo** preserves the current run, clones board A and configures both lanes with local landing choices, 1200ms artificial replies and a 700ms fallback wait. Lane A is assisted and B is unassisted. This is a scheduling demonstration, with no model call or model performance claim. Restoring the preserved run restores its previous sources and settings.

The UI separates Jev, local demo, fallback, human and gravity time; it also shows response wall time, world age, stale reasons and separate failure counts. Code following a Jev-selected destination remains code actuation. The frozen earlier protocol's 25 Jev games cleared zero lines; the existing recorded-comparison tab retains that evidence.

## Checkpoints and handoff

Take either board without resetting it. Arrow keys move/rotate, Z rotates back, C holds and Space drops. Mobile controls include pause/resume beside the board. Scrubbing pauses both lanes and emits no requests. Branching preserves the prior paired trajectory, piece queues, RNG, physics, settings and controller memory. Restoring an older saved run also resets request/recording scheduling relative to its restored clock.

The explicit **Compare both from board A/B** buttons make both physical worlds identical at any selected checkpoint. They preserve score, piece queue and the chosen piece's age, start both controllers fresh and reset coverage counters while retaining each lane's source and assistance setting. Cloning an older piece does not restart its fallback wait. Ordinary branching instead preserves both already-divergent lanes. Both actions keep the earlier run available.

History is in memory until navigation or reload. Export includes the current state, checkpoints, decisions and preserved runs. Each decision receipt freezes the exact issued `{ state, questions }` body, including its instructions and criteria. Successful and failed replies retain the complete normalized gateway body, including probabilities, model, attempts, latency and cost when present; errors also retain HTTP status. Cancelled requests retain their issued body and cancellation reason without inventing a reply. Authorization headers and keys are never part of these receipts. Raw provider HTTP bodies are not exposed by the shared gateway and are not claimed here.

Checkpoints occur every 200ms and at request, resolution, cancellation and control transitions. Transitions within one simulation tick replace that tick's checkpoint, so its counters, pending request and plan agree with the decision inspector. Historical views mask later answers and full replies until their resolution time. Hidden tabs pause and cancel outstanding work. The component's `active={false}` does the same while keeping its mounted history, so switching to the old evidence tab preserves play. After a developer hot reload changes the session class, reload the page before testing; an existing class instance can retain the old prototype.

## Validation

Run from the repository root:

```sh
bun test jev-experiments/live-worlds/tetris
bun jev-experiments/live-worlds/tetris/local-smoke.ts
```

Twenty-seven tests pass with 298 assertions. They cover seeded determinism, reachable routes, four-line clearing and level progression, hold, top-out, finite lock resets, gravity during pending requests, elapsed-time retention, independent lane invalidation, stale piece/age rejection, same-state takeover, scrub/fork cancellation, old-run restoration, matched midgame comparison, provider failure, same-tick evidence consistency, immutable complete request/reply receipts and historical evidence filtering. The fallback tests cover replies within the wait, absent replies, immediate fallback, new-piece request gaps, exact restored piece ages, preserved plans and the explicit local preset. The final app TypeScript check passes.

The [local smoke output](local-smoke.json) covers 60 seconds of simulated time with seed 19, 450ms artificial delay, a 900ms request interval and the current 700ms fallback wait. Assisted code placed 62 pieces and cleared 23 lines; unassisted delayed code placed 61 pieces and cleared 23. Both were still playing. The assisted lane recorded 13.62 seconds of local decision control and 6.5 seconds of fallback. Both recorded **zero Jev time**. This bounded mechanics check does not constrain gameplay or measure a model.

Browser checks used `realtime-independent` on the integrated local route, without provider calls. Desktop 1440px and mobile 390px screenshots were opened and inspected. Keyboard movement/rotation/hold/drop and mobile drop/pause/resume worked. Mobile had no horizontal overflow and control targets were 44–52px tall; reduced motion was enabled. A run at 2220ms branched from 600ms and restored its original clocks and piece counts. Switching to recorded evidence paused at 2600ms and returned unchanged after 1.2 seconds. A fresh-controller comparison at 1740ms produced byte-identical game states with assistance settings `[true, false]`. Screenshot files are in [screenshots](screenshots/), all below 2MB.

A final [browser receipt fixture](browser-receipts.json) passed on the rebuilt preview in `tetris-cross-review`. Intercepted success and HTTP 503 replies retained their complete normalized bodies, and both recorded requests matched the actual wire body including instructions. An intercepted request cancelled by pausing retained its exact body and reason with no invented reply or pending controller. All requests were intercepted; these checks made no provider calls and measure software behavior only.

## Integration

- Import `LiveTetris` from `experience-prototypes/src/live-tetris.tsx`. Its props are optional `result` and `active`; `result` is accepted for compatibility but unused. Keep it mounted and pass `active={tab === 'play'}`.
- The component imports its own CSS. `engine.ts` and `session.ts` contain no DOM or network dependency. Browser requests exclusively use the existing `run/getApiKey` functions and their memory-held BYOK key.
- Root owns the wrapper, catalog, package test command, preparation and deployment. No package, main, catalog, recorder or publication edits were made by this worker.
- New paid model runs, production deployment and touch-device hardware testing were not performed. The landing search is synchronous; very slow devices may accumulate simulation backlog, which is retained rather than silently discarded. In-memory history grows with session length.

The final [fallback-wait browser check](browser-grace.json) verified the rebuilt preview with reduced motion and a dark theme. Both lanes accepted five local replies by 4.32 seconds; assisted control included both local decisions and fallback. The slider supports keyboard Home/End for 0/2400ms, the local preset preserves the current run, and its two cloned boards match. Desktop boards align, and the 390px mobile page has no horizontal overflow.
