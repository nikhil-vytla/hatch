# Outcome framing experiments

## 2026-09-20

- User requested a Tetris experiment comparing action-, placement-, and outcome-oriented questions, plus pixel drawing with direct intensity, shape-membership, and formula-assisted framings. Treat the framing advantage as an open question, not an assumed result.
- User also explicitly approved implementing the music and Cafe Jev improvements during the ongoing 33-experiment audit.
- Plan shared deterministic environments and controls, real recorded Jev calls, full inspectable state/questions/results, animated replay, manual intervention where useful, and live BYOK through existing API.
- No production credential fallback. Existing visitor keys remain in memory.
- Eight initial outcome-framing tests pass: bag determinism, line clearing, reachable-placement replay, shared candidate identity, finite game horizon, pixel-center/reference checks, identical direct-vs-membership inputs, and sequential-context isolation.
- Integrated the music replacement in app main/catalog/publication and added its tests. Two command attempts used the wrong working directory for the integration/prepare step; corrected paths explicitly. Vite found old occupied ports and started this session on5193.
- Provider load is causing retries across recorders. Asked the reliability implementation to use native independent-question batching while preserving exact information sets, full620coverage and all repeat runs; archive its initial protocol pilot separately.

- Started full35episodeTetris and33drawingmap checkpointed recording. One native request at a time within this job, successful judgments immutable. This runs alongside one JudgeBench worker; recorded latency is a throughput-context observation, not an isolated benchmark.

- Recording completed: 35/35 Tetris episodes, 33/33 drawings, 292 accepted native requests across 369 transport attempts. Integrity verifier replays all 611 transitions and reconstructs all 8,448 pixel values from request hashes and raw answers. All 25 Jev games top out without a line; code baselines complete the32-piece horizon. Candidate p0 is heavily selected in outcome/lookahead. These are retained failures, not a demonstration of planning success. Drawing formula assistance is mixed: better for the square hole, worse for the diagonal. Added a visible result caveat and keyboard pixel inspection.
