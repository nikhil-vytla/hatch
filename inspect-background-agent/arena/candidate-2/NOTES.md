# Work notes

- 2026-08-03: Started candidate 2. Assigned axis B, with an append-only session event log as the source of truth and projections for UI and agent consumers.
- Wrote the caller contract first. The public API exposes session intent and stable updates, while sandbox handles, git sync stages, event envelopes, and OpenCode messages stay internal.
- Chose authenticated, user-bound clients for authorship. PR requests retain an opaque authorization grant, never the user's GitHub token.
- Derived the type sketch from the usage. One per-session journal sequencer orders commands; pure `decide` and `evolve` functions own invariants; at-least-once subscribers drive sandbox, agent, child-session, and GitHub effects.
- Made provider effects carry deterministic effect ids. The event feed can redeliver after a crash, while provider adapters prevent duplicate boots, runs, pushes, and PRs.
- Checked `SKETCH.ts` with TypeScript strict mode using the latest compiler. It passes.
- During self-review, found that child-session and GitHub subscribers lacked the projected context needed to act on one delivered event. Added explicit sandbox, agent inbox, child-session, and PR work readers rather than letting subscribers reach into storage schemas.
- Made top-level session ids deterministic from authenticated subject plus request key, and child ids deterministic from the spawn request. This closes idempotency gaps before any journal append.
- Completed the module map, rationale, red-flag check, report, and concise summary. The remaining risks are session-stream throughput, remote idempotency support, event growth, and schema evolution.
