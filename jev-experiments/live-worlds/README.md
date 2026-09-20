# Worlds that keep moving

The user chose a complete game and crowd simulation with synchronized side-by-side branches, human takeover, and rewind that preserves the previous run. Three integrated prototypes now explore that direction. Open the app routes below; the default worlds work without a key, and live Jev uses the visitor's memory-only Gateway key.

| Prototype | What keeps running | What Jev chooses | Inspectable comparison |
|---|---|---|---|
| [Tetris](https://jev-experiments.vercel.app/#experiment/tetris) | Gravity, lock delay, pieces, scoring, levels and game over | A short control, reachable landing, or code-planner objective | Assisted and unassisted lanes share one clock; clone either board into both lanes, scrub, take over, and preserve earlier runs |
| [The square at five](https://jev-experiments.vercel.app/#experiment/crowd) | Twelve fictional residents, queues, needs, visits, weather and scheduled events | Per-resident destinations and responses to a notice | Matched courtyards, a keyword baseline, local fallback on/off, per-resident intervention and saved branches |
| [Ghost Brush](https://jev-experiments.vercel.app/#experiment/ghost-brush) | Immediate procedural drawing | Fit scores for ten original brush descriptions | Same gesture and seed through different materials, queued changes at pen-up, rewind and named preserved variants |

The URLs are the canonical app destinations. See the parent quality report and release notes for deployment status, rather than assuming a local implementation has already shipped.

## Evidence and limits

Tetris is a complete simplified game, with no evaluation step cap. Its local planner plus artificial response delay is clearly labeled. The earlier fixed protocol is a separate tab: all 25 recorded Jev games cleared zero lines. No new model recording establishes improved Tetris skill. Landing features and intent routing supply more code assistance than button control, so the comparison does not isolate wording.

The courtyard includes one genuine 24-question Jev batch for twelve residents. The recorded replay applies the same returned plan to identical states before comparing fallback off/on. It does not reproduce the measured service latency. Fictional needs and comfort scores do not establish accurate human behavior prediction. Fresh live branches make independent calls and can diverge due to model variability as well as assistance.

Ghost Brush includes two authored phrases and twenty real recipe-fit judgments. Jev sees descriptions and parameters, not image pixels or pointer samples. The renderer is original deterministic code. Neither curated examples nor a lexical baseline establish aesthetic superiority.

Every new world separates local code, recorded answers, live answers and human intervention. Requests are validated against relevant branch and actor revisions rather than full moving-state equality. Exact input and response receipts belong to their historical checkpoints. Failed and cancelled requests remain distinct from model judgments.

## Review and reproduction

Independent cross-review found and repaired mutable crowd observations, missing failure receipts, lost brush-selection provenance, active-stroke undo, and same-tick Tetris evidence mismatch. Scoped reports retain the findings and describe their follow-through. The full app test suite covers engines, asynchronous lifecycle, evidence and credential isolation; browser checks exercise both desktop and 390px mobile layouts, dark mode, takeover, scrub, restoration and delayed responses.

```sh
bun jev-experiments/live-worlds/prepare.ts
bun test jev-experiments/live-worlds
cd jev-experiments/experience-prototypes
bun run test
bun run build
```

Canonical recordings are compact JSONL. Preparation reconstructs ignored JSON imports for the browser and never reads an owner credential. Local recording CLIs are separate and are never imported into deployed app or API modules. No fetched game or brush repository is vendored.

See [Tetris](tetris/README.md), [crowd](crowd/README.md) and [Ghost Brush](ghost-brush/README.md) for exact protocols, controls, tests, and limitations. The earlier [timing sketch](../real-time-playground/README.md) remains a small tool for exploring useful-action duration and simulated latency. [Creative interaction research](../creative-interaction-research/README.md) records the primary references behind the visual direction.
