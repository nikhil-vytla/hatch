Hardened the local Inspect hatch against the usual harness failure modes: serial session queues, idempotent sandbox lifecycle with TTL reap, a thin free-model surface, and scripted smoke evals, steered by a verbatim experiment [AGENTS.md](AGENTS.md). Fake demo/adapter paths and the unused session actor were removed so the control plane is the only product. `npm test`, `npm run e2e` (including DELETE diskGone), and `npm run eval:smoke` (2/2) are green on OpenCode free models without API keys.

- Async: per-session promise chain, not a global worker pool
- Lifecycle: `DELETE` + idle TTL; destroy twice is safe
- Evals/models: [`eval-smoke`](scripts/eval-smoke.ts) + [`GET /api/models`](src/agent/models.ts)
- Inspiration (not a fork): [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents); Ramp topology in [`design/TOPOLOGY.md`](design/TOPOLOGY.md)
