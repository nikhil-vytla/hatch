# Independent prototype review

Reviewed the HTML and design tree on September 20, 2026, then exercised the local sketch in the `realtime-independent` browser at desktop 1440px and mobile 390px. No model calls. Screenshots were opened and inspected. These findings concern the sequential saved-branch sketch. The user has since chosen assisted/unassisted comparison, a full game plus crowd, and synchronized side-by-side branches; the current HTML does not implement that final layout.

## Defects

- **P1: restoring an older run retains the newer run's scheduling clocks.** Save a crowd run at 2.525s, start another and reach 7.025s, select the older run, choose Return to latest, then Start. After another 2.258s of motion, the old run still has 25 checkpoints and 4/4 returned decisions. Its last request remains at 2.425s. `saveBranch` restores state/history but omits `lastSend` and `lastSnap`, so both operations wait for the older world to catch up with the newer world's timestamps. Save and restore scheduler state, or explicitly initialize the next snapshot/request relative to the restored clock.
- **P2: population changes save mismatched settings.** From a 32-person crowd, select 64, then restore the automatically saved old run. The inspector contains 32 people while the population selector reads 64. `onchange` saves after the control value has changed. Capture the old run's settings from its own state before changing them.
- **P2: scrubbing mixes historical state with later decisions.** `sync` selects a historical state but keeps the full run's decision count, event strip, and `latestDecision`. Thus an early checkpoint can appear beside a request made later. Show the decision active at the checkpoint, filter time-dependent statistics, or explicitly label those values as whole-run evidence. `branch` also records its first snapshot before clearing action leases, so its initial saved state and actual starting state differ.
- **P2: world time slows under frame stalls while response time does not.** The world uses `min(40ms, frame elapsed)`, discarding excess elapsed time, while requests use real timers. This is a source-level finding, not a measured device-performance result. At 20 frames per second, the nominal world clock advances at most 0.8 seconds per wall second. Use fixed simulation steps with a stated catch-up policy and record both clocks before drawing latency conclusions.

## What held up

The local heuristic and artificial delay are clearly named in both the source selector and an adjacent explanation. The desktop canvas is legible; the 390px layout wraps controls without horizontal overflow. Keyboard takeover preserved the world and moved the actor from x=120 to x=172.5 during a 350ms ArrowRight press. Source inspection confirms tap-to-steer, focus handling, cancellation on pause/source/world changes, epoch checks, and decision-age limits. Actual live-provider responses and touch hardware were not exercised.

For the agreed comparison, retain the distinction between code executing a selected destination and code selecting a new fallback destination. Crowd ownership is currently an average fraction of actor-time under a returned destination, not proof of model-controlled motion. Matching checkpoints alone also does not match random hazard perturbations or later settings changes. Preserve those events and display assistance time independently in the new implementation. These are implementation requirements, not a new architecture decision.

Screenshots: `output/playwright/realtime-independent-desktop.png` and `output/playwright/realtime-independent-mobile.png` in this investigation folder.

## Follow-through

Root repaired the four findings after this review. Browser regression restored the 1.4-second, 32-person run after a newer 3.1-second run: resuming for 1.7 seconds increased checkpoints from 13 to 28 and returned decisions from 2 to 4. Scrubbing to time zero showed 0/0 decisions, no latest answer, and no future events. Forks now clear action leases before saving their initial snapshot. The animation loop retains elapsed backlog in fixed steps rather than discarding it; no device-performance or actual-provider timing claim follows from that source correction. The new integrated Tetris and courtyard implement the agreed simultaneous layout.
