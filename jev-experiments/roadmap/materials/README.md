# Materials sandbox

A usable local 96 by 64 cellular sandbox is exported by `MaterialsSandbox.tsx`. Six built-in materials cover sand, water, stone, wood, fire and steam. A seventh slot offers four movement types and one contact transformation. The engine has no network dependency; optional Jev interpretation returns a proposal for the same controls and requires explicit application.

Paint with mouse, touch or keyboard. The terrarium is the default scene. Play, pause, step, reset and preserved branches let users compare changes. Browser saves and validated JSON import/export preserve cells, ages, random state and rules. Public preset links contain only a preset name; scene exports intentionally include custom instruction text. Compact mode keeps the canvas and painting controls first and moves the remaining controls behind a toggle.

Run `bun test jev-experiments/roadmap/materials/engine.test.ts` from the repository root. Eight tests passed on 2026-09-20. App `bunx tsc --noEmit` passed after integration. Browser, release and deployment acceptance belong to the root roadmap; these checks alone do not establish those gates.

`PROTOCOL.md` and `labels.v1.json` freeze the instruction-to-rule task before recording model outcomes. No model results have been recorded and no interpretation-accuracy claim is made. The mechanics are intentionally small and are not a physics model. Shared [Patchwork history ideas](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/) informed the preserve-and-branch interaction; this implementation contains no copied upstream code.
