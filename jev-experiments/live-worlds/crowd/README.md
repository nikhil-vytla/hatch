# Bramble Square

Twelve fictional neighbors move through a courtyard with a café, bakery, reading room, garden, music stage and fountain. They get hungry, need rest, seek company, join queues and react to the same seeded weather schedule. A notice can change each resident's destination without stopping the world. The browser experience lives at `#experiment/crowd` and exports `LiveCrowd` from `experience-prototypes/src/live-crowd.tsx`.

## What chooses and what moves

The engine advances in fixed 1/30-second steps. A tested accumulator retains slow-frame backlog while processing at most 90 steps per rendered frame; it never truncates elapsed active time. Deliberate pause, restore and visibility changes clear the accumulator. Rendering uses Canvas and requestAnimationFrame; a model promise never appears in the simulation loop. Both worlds advance together. Hidden browser tabs suspend world time, and the user can deliberately pause. Reduced-motion settings remove decorative bobbing and animated rain while preserving the simulation.

Each side can use a deterministic needs policy, a limited local keyword policy, Jev, or direct human control. Jev receives the notice, current weather/event, open destinations and queues, and each resident's story, preferences, needs and recent visits. Two typed choice questions per eligible resident ask for a lasting destination and a relationship to the notice. No answer depends on another answer. The model does not receive the future event schedule or simulator RNG.

Code owns movement, collision separation, legal destinations, capacity, queues, service duration and needs. Walking toward a Jev-selected destination remains attributed to Jev. An assisted Jev side may use the needs policy to select a new target between model plans; an unassisted side finishes its existing target and then waits. The local notice policy uses keywords and clause-level negation. It is deliberately limited and is labeled as code, never Jev.

The comparison button clones courtyard 1 into two identical worlds and changes only fallback settings. Each side can then request the same Jev contract. Live inference is explicit: posting a notice to a Jev side, asking that side to plan, or asking both. There is no unattended stream of paid requests. A single live request covers all eligible residents in that lane.

## Rewind, branch and intervene

Checkpoints every two world seconds contain both full worlds, actor intent versions, action memory, accepted evidence, controller/fallback settings, RNG state, scheduled disturbances and UI selections. Changes and model decisions create additional checkpoints. Scrubbing pauses the world and issues no requests. Playing from an old checkpoint creates a new branch and preserves the previous run. Preserved runs remain in this browser tab; download exports branches and decisions. Reloading clears this in-memory session. Importing saved sessions is not implemented.

Select a resident on the canvas or through the keyboard-accessible roster. Either lane can be selected in the inspector. A human destination has priority for 22 world seconds and changes only that actor's intent version. Other valid answers in the same model batch may still apply. Returning the resident to its controller restores the selected controller's behavior.

Requests carry branch ID, epoch, notice revision, actor intent versions and an 18-world-second expiry. Ordinary movement does not make a response stale. A branch change, notice edit, human intervention, completed visit, newly started visit or closed destination can invalidate it. Pause, restore and unmount abort pending work. Failed or late calls do not stop the world. Guard outcomes are reported separately from raw answers. At issuance, a durable receipt deep-copies the exact observation, questions and ticket; it later becomes returned, failed or cancelled. Failed receipts retain the sanitized gateway status/body and attempts. Earlier checkpoints keep their historical pending state, without future responses; a fork cancels inherited pending requests instead of restarting them.

## Genuine saved example

`demo.jsonl` uses the existing records codec. It contains the exact request, raw provider response, attempt metadata, request SHA-256, frozen simulator state, ticket and guard outcome. `demo.json` is an ignored derived bundle artifact generated from the canonical JSONL by `live-worlds/prepare.ts`; do not commit the duplicate. `record.ts` is a local-only recorder; it imports the existing authorized credential helper and is never imported by browser code.

One authored quiet-reading invitation was sent as **one actual HTTP 200 batch with 24 typed answers for twelve residents**. Service and total gateway latency were **578 ms**, with zero retries. All twelve destination decisions were legal at the frozen checkpoint. Mina and Ivo chose the library, Nia the stage, Remy the bakery, Bea the garden and Kit the café; six residents chose to keep their existing plans. The complete distributions and reactions remain in the files. This is one demonstration, not an accuracy benchmark or a model of real human behavior.

“Watch a recorded Jev afternoon” applies this exact saved plan to both identical frozen states, then runs fallback off/on. Playback applies decisions instantly and does **not** reproduce the 578 ms service delay. It never substitutes an authored target for a model answer. The test suite checks exact observation and question parity against the recording. Live and recorded actor decisions have separate source labels and counters. A comparison using the same recorded plan isolates this simulation's fallback policy; it does not establish that Jev improves outcomes over a strong controller on unseen tasks.

## Verification

Run from the repository root:

```sh
bun jev-experiments/live-worlds/prepare.ts
bun test jev-experiments/live-worlds/crowd/engine.test.ts
bun jev-experiments/live-worlds/crowd/verify-evidence.ts
cd jev-experiments/experience-prototypes
bunx tsc --noEmit
```

Sixteen engine tests pass, including 500 seconds of equal seeded disturbances under different policies, movement during a pending request, actor-specific human overrides, revision/expiry/branch guards, closed destinations, deterministic checkpoint futures, identical initial comparison states, source attribution, capacity/need bounds, immutable request receipts across advancing frames, long-frame catch-up, pending/failed/cancelled receipt history and exact recorded replay. The suite contains 32,594 assertions. TypeScript passes.

A dedicated Playwright session at port 5193 verified pause/play, notice scoping, human intervention, replay disabling live posting, preserved branching, 390 px mobile layout without horizontal overflow, dark theme and reduced-motion settings. An explicitly mocked 2.2-second response left the world moving and rejected only the overridden resident. A mocked 503 displayed the failure while the clock continued. These fixture responses are not recorded model evidence. Two early test-harness attempts failed because its runtime lacks a global timer and a closed details panel hid a row; the corrected checks passed. One dummy-key request returned 401 during that harness setup; no browser used an owner key. Screenshots are in `qa/` and each is below 2 MB.

A final check against the built preview at port 5195 verified that pending and failed receipts match the exact intercepted request body. Pausing cancelled the pending receipt, preserved its input and prevented the delayed answer from being stored. Scrubbing to the issue checkpoint showed only its historical pending state. The failed receipt retained the mocked 503 status, attempt and retry delay; no receipt contained the dummy key, and reloading cleared the connection. These checks made no provider calls.

## Files and integration

- `engine.ts`: deterministic state, policies, guards, snapshots and recorded-plan replay.
- `render.ts`: original Canvas illustration, hit testing and source rings.
- `engine.test.ts`: simulation, lifecycle and evidence tests.
- `record.ts`, `demo.jsonl`, `demo.json`: local recorder and genuine one-batch evidence.
- `src/live-crowd.tsx` and `.css`: paired worlds, controls, inspector and evidence export.

No additional dependency is required. Root owns the shared route, catalog, publication and build. Include the test file in the existing test command. An offline verifier confirms the request hash, frozen observation, native wire payload, all 24 native answer values/distributions and canonical/derived equality. No credential-shaped fields occur in the evidence; a separate boolean-only scan found zero occurrences of the actual authorized key in the evidence or browser entry files. No app settings or secret files are needed in the bundle. Browser live calls use only the existing memory-held BYOK API.

The [Canvas 2D API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API) supplies the original drawing; [React](https://react.dev/reference/react/useEffect) owns the component lifecycle and cleanup. The next useful evaluation is a frozen matrix of notices, counterfactual wording and seeds with independent relevance labels and identical planning opportunities. Comfort here is an authored needs score, not evidence of realistic welfare. Long sessions retain their checkpoints in memory and will eventually need compact event replay or explicit archival limits.
