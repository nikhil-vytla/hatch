# Interaction patterns for Jev Lab

These are design recommendations inferred from the inspected works, not claims that those authors used Jev, asynchronous AI, or checkpoint branching. The evidence and inspection limits are in [sources.json](sources.json).

## 1. Put a small action before the explanation

The first screen should contain something to do and enough context to predict its consequence. A single slider, choice or gesture can carry the invitation. Trust's first choice and Harmony's brush are concrete references; Neal's circle is a promising reference with lower inspection confidence because our browser attempt was blocked. [Trust](https://ncase.me/trust/), [Harmony](https://mrdoob.github.io/harmony/), [Circle](https://neal.fun/perfect-circle/).

For Jev, start with a moving character, an audible loop, or an editable scene. Offer one short instruction such as “Get the fragile parcel home.” Reveal the candidate actions after the first result. Keep Run, Pause, Step, Reset and the current objective visible; put protocol details behind an inspect control. A loading state should not replace the whole world.

## 2. Show the thing that caused the outcome

A visible path, force arrow or transition edge is more useful than a decorative burst. Red Blob's explanations connect graph state to geometry; Ciechanowski makes invisible forces legible. [A*](https://www.redblobgames.com/pathfinding/a-star/introduction.html), [Bicycle](https://ciechanow.ski/bicycle/).

Use four distinct overlays: **observed world**, **legal actions**, **Jev's ranking**, and **executed action**. Highlight only the selected action by default. Let the reader reveal the rejected choices and deterministic consequences. Label supplied evidence separately from hidden environment state: a character that has never seen a key must not receive its location through a debugging prompt.

## 3. Give the simulation and semantic decisions separate clocks

Bruno Simon's source orders input, physics and rendering explicitly. That architecture makes a helpful starting point, but its wall-clock loop is not proof of reproducible simulation. [Folio source](https://github.com/brunosimon/folio-2025).

Proposed Jev architecture:

| Layer | Work | When it runs |
|---|---|---|
| Renderer | Interpolation, camera, trails, particles, animation | Every animation frame |
| Simulation | Movement, collisions, inventory, queues, score | Fixed simulation ticks |
| Decision scheduler | Capture evidence and produce bounded candidate actions | Arrival, changed objective, or another declared event |
| Jev request | Rank/score the supplied candidates | Once per decision epoch |
| Commit | Validate candidate identity and action preconditions; apply | A declared action/bar/turn boundary |

Keep the last committed action while a request is pending, then wait at a safe boundary if it finishes first. This is a proposed default pending the user's late-answer preference. Show “decision pending” and elapsed wall time separately from simulation time. On provider failure, retain the failure and offer manual control or an explicitly named deterministic policy; never present fallback behavior as a model result.

Attach `episodeId`, `branchId`, `decisionEpoch`, input hash, candidate-set hash and protocol hash to each request. Reject answers for another branch or superseded objective. A continuously moving world will change its full state hash every tick: **do not use full-hash equality as the universal acceptance rule**. Preserve that hash for provenance, then check the relevant semantic revision and action preconditions. If a candidate encodes a specific simulated future, recompute that future before committing when its physical assumptions have changed.

## 4. Record decisions once; replay without asking again

Historical Red Blob implementation notes describe rerunning cheap deterministic search to reconstruct a step. Re-querying Jev would change the experiment as well as add latency. [A* making-of](https://www.redblobgames.com/pathfinding/a-star/making-of.html).

A checkpoint needs more than a screenshot:

```text
protocol/version + source/candidate hashes
episode + branch + parent checkpoint + simulation tick
complete world state + entity IDs + velocities + inventories + agent memory
RNG state + independent exogenous event schedule
queued deterministic events + last committed actions
recorded decisions: request evidence, ordered candidates, response/error,
                    request/arrival/commit times and ticks, fallback identity
```

Scrubbing replays recorded inputs and decisions. Forking copies the checkpoint and creates a new branch ID; pending calls from the parent cannot mutate it. Comparing two branches should preserve the same external event schedule, not merely start a global RNG with the same seed: different agent choices can otherwise consume different numbers of random draws. Use separate streams or event-indexed randomness for weather, arrivals and agent variation.

Offer “change wording,” “force this candidate,” and “change information” as separate fork types. Each changes one identifiable cause. Ghost paths should be aligned to the same simulation ticks, with divergence marked at the first differing committed action. Show simulation outcomes only as outcomes of the toy world.

## 5. Let failures teach a specific mechanism

Trust turns a losing choice into the next lesson; Setosa makes an invalid transition matrix visible. [Trust](https://ncase.me/trust/), [Markov Chains](https://setosa.io/ev/markov-chains/).

Use authored scenarios that distinguish failures: wrong goal interpretation, missing memory, a blocked route, poor timing, or an unavailable provider. When a run fails, pause at its first consequential decision and show what the model saw. “Try the other action from here” is stronger than “try again.” Keep wrong judgments in the record. Do not retry them until an agreeable answer appears.

A layered progression works well: make a prediction, watch one consequence, reveal the mechanism, introduce one counterexample, then unlock the sandbox. Success should open investigation rather than end it.

## 6. Separate score, uncertainty and availability

Seeing Theory distinguishes a known reference distribution from a finite sample; Setosa's transition probabilities are parameters of its model. Neither licenses calling a Jev ranking score a calibrated probability. [Seeing Theory](https://seeing-theory.brown.edu/basic-probability/index.html), [Markov Chains](https://setosa.io/ev/markov-chains/).

Display exact score labels from the protocol, candidate ties, winner changes across unchanged repeats, and sample counts. “Two of three repeats chose the bridge” is inspectable; “67% confident” asserts more. Distinguish simulation randomness from variation in model responses. A missing answer is “unavailable,” with its denominator preserved. Render an unobserved metric as “no samples,” avoiding the NaN state observed during our Seeing Theory visit.

If calibration matters, predeclare labeled held-out cases and evaluate it separately. For aesthetic tasks, use transparent preference comparisons and rule adherence; do not invent an accuracy target.

## 7. Make motion preserve causes and agency

Comeau's follow-up distinguishes a sampled spring-shaped easing curve from a spring that preserves velocity when interrupted. [Linear timing functions](https://www.joshwcomeau.com/animation/linear-timing-function/).

A changed Jev intention should change a target; local steering should turn the actor toward it. Avoid teleporting to a new position or restarting a canned movement that erases momentum. For music, schedule the next choice on an audio boundary. For a drawing tool, finish the current stroke before changing brush parameters. These boundaries make latency understandable and preserve control.

## 8. Keep the world playable through simpler controls

The personal checks found pointer hitboxes, generic button-like elements and unnamed icon buttons. These are inspection observations, not full accessibility audits. Preserve the ideas while supplying native labeled buttons, keyboard movement, focus indicators, text equivalents for state changes, and non-color distinctions. Provide Pause, single-step and a quiet camera; reduced motion can remove particles, spring overshoot and camera drift while preserving essential movement. Audio must be optional with a visible rhythm/state equivalent.

Keep restart and unstuck cheap. Bound the canvas size on mobile, support pointer cancellation, and expose the same selected object through DOM controls. A text event log should explain the important action without announcing every physics tick.

## 9. Choose the smallest rendering stack that reveals the mechanism

Use existing React and Motion for controls and transitions, Canvas2D/SVG for the first worlds, and original deterministic state code. Add 3D physics only when depth, collisions or spatial exploration answer the design question. canvas-sketch's explicit render inputs and export API are useful references for reproducible exports, but they do not automatically capture RNG or model decisions. [canvas-sketch API](https://github.com/mattdesl/canvas-sketch/blob/master/docs/api.md).

Licenses are artifact-specific: Red Blob sample code and Haxe visibility source are Apache-2.0; Nicky Case repositories are CC0; canvas-sketch and Bruno's portfolio repository are MIT; Harmony is GPL-3.0-or-later. Seeing Theory has inconsistent reuse guidance, and Distill's article and repository state different attribution licenses. [Source and license catalog](sources.json). Original implementations avoid unnecessary dependence on old code while keeping the design lineage explicit.
