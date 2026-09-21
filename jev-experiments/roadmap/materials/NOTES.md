# Materials implementation notes

- Inspected existing app APIs, React/Vite dependencies, crowd and music engines. Reused the app's typed Jev request transport; no new rendering or simulation dependency is needed.
- Added a deterministic 96 by 64 cellular engine with six built-in materials, eraser and one configurable typed slot. Rules cannot execute code.
- Froze 12 instruction-to-rule cases before making model calls. No model result has been recorded, so UI and documentation must not imply interpretation accuracy.
- Scene exports contain painted cells, current simulation state and custom instruction. Public preset links include only a named built-in preset; user text never enters links automatically.
- Implemented React canvas UI with mobile pointer capture, keyboard cursor/painting, reduced-motion pause default, compact homepage mode, typed proposal review, manual editing, presets, browser saves, branching and JSON import/export.
- Eight engine tests passed: deterministic replay, material motion, contact semantics, connected strokes/bounds, scene validation, branch independence, invalid/unsupported model replies, and delayed reply invalidation. These are behavior checks, not model-quality evidence.
- App TypeScript compilation passed after integration. Root integrator owns browser visual review and deployment checks.
