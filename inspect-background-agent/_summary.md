Built a hatch-scale Inspect-style background agent from Ramp's [why we built our background agent](https://builders.ramp.com/post/why-we-built-our-background-agent) post using `/architect`: grounded the Sandbox/API/Clients/OpenCode spec, ran a four-way arena (session-actor, event-log, capability tokens, workspace-first), and implemented the synthesized design as a TypeScript ports/adapters package with local fakes.

- Workspace-first base: repo owns images/pool/leases; session is a short lease plus conversation
- Typed write gate via `admitWrites()`; `InstallationToken` vs `UserToken` for clone/push vs PR
- Session command mailbox, prompt queue, multiplayer authorship, Slack-shaped `dispatch`
- 7 passing tests and `npm run demo` covering create → sync-park → stream → PR without cloud credentials
