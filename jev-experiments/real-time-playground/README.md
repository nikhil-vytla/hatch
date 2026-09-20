# Life keeps moving

A playable design sketch for Jev in a continuously running environment. Open `/research/show-me-realtime.html` in the app, or serve `show-me-realtime.html` locally. The flight world and the crowd keep moving while a separate asynchronous controller makes decisions. The default controller is a local heuristic with an adjustable artificial response delay; it is not a Jev speed or quality measurement. Live mode uses a visitor-provided Vercel AI Gateway key kept only in page memory.

## Try these comparisons

1. Start the flight world with a 1,200 ms delay and **One short steering action**. The observation marker stays behind, answers miss their 450 ms useful window, and the selected fallback carries on.
2. Change to **A destination that stays useful** at the same delay. Destinations can remain relevant for five seconds, though a collected beacon invalidates its old identifier.
3. Take control, steer with arrows or a click, then hand back control in the same world.
4. Pause, scrub to an earlier moment and branch. The previous run remains selectable. Changing worlds or crowd population also saves the old trajectory.
5. Switch to **Many little decisions**, choose 64 visitors, and make everyone tired while a decision is in flight. One batch chooses semantic destinations; rendering and movement continue independently.

The useful-window durations and local policy are exploratory settings, not calibrated recommendations. Button, destination and simulated-future formulations expose different information and control horizons, so their outcomes are not a controlled model ranking. A full-state mismatch is inevitable in a moving world; real controllers need action-specific validity conditions.

## Review status

Playwright checked a moving clock during a delayed decision, rejection after the useful window, 64-visitor motion, preserving and restoring branches across world types, controller restoration, and a 390 px viewport without horizontal overflow. The mobile screenshot was visually reviewed. Model-backed calls have not been measured in this sketch. The existing recorded Tetris and Snake protocols remain separate bounded comparisons.

The first design round is settled in [DESIGN-TREE.md](DESIGN-TREE.md): compare assisted and unassisted control, build a full game plus a crowd, and synchronize side-by-side branches. Those choices now have integrated prototypes in [live worlds](../live-worlds/README.md). This earlier sketch remains useful for changing latency and useful action duration. Inspiration and hands-on notes are in the sibling [creative interaction research](../creative-interaction-research/README.md), particularly [Red Blob Games](https://www.redblobgames.com/pathfinding/a-star/introduction.html) and its separation of inputs, internal state and visible consequences.

A follow-up browser check verified the independent review fixes: restoring the 1.4-second crowd after a newer 3.1-second run resumed both snapshots and decisions immediately. The restored population was 32, and scrubbing to the first checkpoint showed zero returned decisions and no future answer. The fixed-step clock retains elapsed backlog. These are local lifecycle checks, not provider-latency measurements.
