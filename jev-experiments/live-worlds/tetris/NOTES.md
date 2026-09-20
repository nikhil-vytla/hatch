# Tetris implementation notes

## September 20, 2026

Read the agreed live-worlds brief and reviewed the earlier timing sketch independently. The new game uses a pure deterministic engine and a paired session, with async requests outside the simulation clock. Both lanes support the same source and decision formulation with different assistance settings. No recorded success will be inferred from local planning, and the earlier frozen 25-game Jev result of zero cleared lines stays visible.

Rules will be declared as a simplified Tetris variant: 10×20 board, seven-bag pieces, clockwise/counterclockwise rotation with a small explicit kick list, 450ms lock delay with a finite reset count, hold, ghost, next queue, line scoring and speed progression. There is no fixed play horizon. Browser calls use the existing memory-held BYOK API only.

## Engine and lifecycle checks

Implemented a deterministic seven-bag engine with full play beyond a benchmark horizon. Reachable landing enumeration checks actual movement routes, including slides under overhangs, and reports computed post-clear features. Two lanes share a 20ms clock, with independent ticket validation by epoch, controller revision, piece identity, world-time age and current landing reachability. Slow renders retain unprocessed elapsed time. Nineteen tests pass with 230 assertions; app TypeScript checking passes.

The 60-second local smoke run placed 141/61 pieces, cleared 54/23 lines and left both lanes playing. Jev time was zero in both lanes. This proves mechanics and local actuation only. Model choice, code actuation, fallback and artificial timing are explicitly separated.

## Browser and visual review

Integrated route verified at 1440px desktop and 390px mobile. Opened and inspected screenshots, now copied into this folder's screenshots directory, all under 2MB. Keyboard move/rotate/hold/drop and mobile drop worked. Added pause/resume next to human controls to avoid scrolling back to the header. Mobile scroll width matched its 390px viewport; touch controls measured 44–52px high. Reduced-motion mode was enabled. No paid provider calls or credentials were used.

A 2220ms run branched at 600ms and restored the original time and piece counts. Hiding the mounted live view for recorded evidence paused at 2600ms and returned unchanged after 1.2s with cleared pending slots. Added matched comparison buttons that clone either selected board, clear prior controller plans and reset coverage while preserving its score, RNG and queue. Browser inspection confirmed identical games at 1740ms with independent assistance settings. Added the seed to snapshots so restoring an old piece sequence also restores its control label.

Two development-only refresh interruptions were observed while parent integration and this session's class methods changed. Old useRef instances retained the old class prototype. A page reload and fresh scripted run passed; this is documented for further local development. Earlier incomplete browser sequences were not counted as validation. Final desktop and mobile screenshots show the latest latency display and matched comparison controls. Actual provider latency, real Jev play and touch hardware remain untested.

## Independent evidence review fixes

A second reviewer reproduced a same-tick inconsistency: a response accepted at world time 200ms left the stored 200ms checkpoint pending, even though the inspector showed its answer. Requests, accepted/stale/failed resolutions and cancellation now checkpoint their state transitions; the latest transition at one clock time replaces that checkpoint. Tests verify pending slots, counters and plans together. Historical inspection also removes the complete response until its resolution time.

Moved the actual decision instructions into the session request builder. Tickets and events retain an immutable deep copy of the exact issued state/questions body. The live component sends that stored body and keeps the full normalized gateway response rather than extracting only the choice. Root added EvaluationError to shared api.ts, so failed HTTP responses now retain attempts/retry metadata and status as well. Local replies are explicitly marked modelCalled=false; cancellations preserve request/reason without synthesizing provider output. New tests mutate the caller's response after delivery and verify that probabilities, model, cost, attempts and latency remain unchanged in exported and preserved receipts. The suite now passes 22 tests with 256 assertions.

An attempted browser fixture check was blocked before any request by a transient Vite overlay for root's missing live-world-preview module. The final typecheck reported that same shared integration issue and no Tetris errors. No synthetic test output was counted as a successful browser check, and no request reached a provider.

## Final rebuilt-preview receipt check

After root restored the shared preview module, the full app typecheck passed. In a fresh stable5195 page, browser fixtures intercepted every evaluate request. The success receipt matched the wire body including instructions and retained probabilities, confidence, model, attempts, total/service latency, retries and cost. The synthetic HTTP503 receipt retained its full error, attempts, retry_after_ms and HTTP status. A held request cancelled by pausing retained its exact body and cancellation reason, with no reply and no pending controller. Results are in browser-receipts.json. A first cancellation-fixture attempt used a timer unavailable in the CLI evaluation scope; the held-route retry passed, and the artifact explains its cumulative cancellation count. No provider calls occurred. Fixture routes and the memory-held dummy key were removed after verification.

## Per-piece fallback wait and final smoke check

The immediate fallback could lock a piece before an ordinary 450ms reply arrived. Added an assisted-lane wait from each new piece's spawn, defaulting provisionally to 700ms with a visible 0–2400ms control. Zero retains the earlier immediate behavior. Gravity continues throughout, valid plans survive wait-only changes, and exact piece age is preserved by checkpoints, restoration and matched comparison. A clearly labelled local slow-reply preset preserves the old run before cloning board A and setting 1200ms artificial replies, 700ms wait, and assisted/unassisted lanes. No frozen benchmark or provider calls changed.

Five regression tests bring the suite to 27 tests and 298 assertions. They cover replies within the grace, absent replies, zero wait, the request gap after a new piece, exact restored clocks/settings, and preserved preset originals. The current 60-second local smoke run placed 62/61 pieces and cleared 23/23 lines. Assisted coverage includes 13.62s local decisions and 6.5s fallback; both lanes report zero Jev time. This supersedes the earlier immediate-fallback smoke numbers above. App TypeScript checking passed.

Final browser verification used the rebuilt 5195 preview in tetris-cross-review. At 4320ms, both lanes had accepted five local answers with no stale replies; assisted coverage included 980ms local decisions and 160ms fallback. Home/End set the wait to 0/2400, and keyboard arrows restored 700. The local preset preserved the original run and produced identical boards with the declared 1200ms delays and independent assistance settings. Both desktop board tops aligned exactly, and the 390px mobile viewport had 390px scroll width. Updated desktop/mobile screenshots were opened and inspected and remain below 2MB. Compact observations are in browser-grace.json.

One screenshot attempt mistyped the existing intro selector and timed out before capture; the corrected rebuilt-preview sequence passed. The papercuts tool refused a log because this repository has not opted in; no log file was created. No provider request occurred during these checks.
