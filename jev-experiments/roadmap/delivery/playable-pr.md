### Summary

The lab needed scenes that users could manipulate immediately and a clearer visual direction. This slice adds a deterministic material sandbox, crowd/music helpers, matched live Tetris evidence and attributed design-engineering research with original interactive styling artifacts.

These authored modules and reports precede the final app-wiring patch. Each simulation keeps its own clock, history and valid actions.

<pr-train-toc>

- [Typed runtime](https://github.com/nikhil-vytla/hatch/pull/58)
- [Routing and client integration](https://github.com/nikhil-vytla/hatch/pull/59)
- [Local study and Mac toolkit](https://github.com/nikhil-vytla/hatch/pull/60)
- [Playable scenes and design research](https://github.com/nikhil-vytla/hatch/pull/61) (current PR)
- [Application and release evidence](https://github.com/nikhil-vytla/hatch/pull/62)

</pr-train-toc>

### Hypothesis

Direct editing, visible state and recoverable branches make model decisions easier to understand. A working scene should lead the page, with detailed settings and evidence available when needed.

### Learnings

- Materials supports six built-ins, one typed custom slot, painting/inspection, keyboard and touch input, branching, saved scenes and JSON export. Manual rules work without a model. Instruction interpretation has frozen labels but no published accuracy result.
- Crowd exposes notices and individual observations; music preserves phrase locks and continuity constraints, saves scores and offers source-hidden auditions. Listener preference remains separate from objective music-quality claims.
- Six actual unassisted Tetris games used three matched queues. Button framing cleared 0/0/0 lines; landing framing cleared 0/3/1. All games topped out. Failures and controller ownership remain in the traces, and the two framings receive different information and code actuation.
- The design study credits Wojciech Dobry, Rauno Freiberg, Emil Kowalski, Josh Comeau, Paco Coursey and Maggie Appleton through primary sources. Captured references informed original controls and styling; their screenshots are study artifacts, not Jev branding assets.

> [!NOTE]
> Start with the material engine/component and the short playable helpers. The design report, reference board, style study, screenshots and Tetris JSONL are supporting artifacts. No fetched repository is included.

### Testing

- [x] Material-engine and crowd/music behavior tests; stale-result guards independently reviewed.
- [x] Desktop and 390 px emulation, keyboard/pointer/touch emulation, dark/reduced-motion behavior, full screen, branches, save/restore and exports. Physical-phone testing is not claimed.
- [x] Live Tetris protocol, all six completed games and source-linked metrics retained.
- [x] Eight serialized local production-build frame samples cover the four scenes at desktop and mobile sizes. The final integration report retains raw intervals, callback costs, host details and measurement limits.
- [x] Assembled branch `ce8b0243dae2` passed locked Bun installation and 15 material/crowd/music engine tests with 47 assertions. No provider calls or model inference were needed.
