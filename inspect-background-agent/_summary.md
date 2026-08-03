Shipped a working local Inspect-style harness in hatch — control plane, real git sandboxes, and OpenCode free models — after studying Ramp's posts, the CTO topology, and [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) for inspiration (not a clone).

- `npm run e2e` creates `src/math.ts` via OpenCode in an isolated `/tmp` sandbox and commits it
- `npm run serve` exposes a web UI + REST/WebSocket API on `:8787`
- Sandboxes use `--dir` so OpenCode cannot write into the hatch repo by mistake
- Design docs keep the three-plane map and peer comparison (Valet/Cursor Cloud/Devin/etc.)
