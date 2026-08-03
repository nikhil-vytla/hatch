# Module map (synthesized)

```
src/
  kernel/       brands, Result, Clock
  identity/     Actor, InstallationToken, UserToken
  workspace/    root aggregate: images, pool, leases, routing, stats
  slot/         Freshness, LeasedSlot, MutableSlot, admitWrites, ToolEffectPolicy
  session/      turn queue, mailbox, transcript, publish
  agent/        AgentRuntime port + TurnCapabilities (spawn, childStatus, status)
  clients/      slack dispatch binder, web grant helpers
  ports/        ComputePort, ImagePort, StorePort, ForgePort, BusPort, …
  adapters/
    local/      directories, tarballs, fake forge, scripted agent
    (future)    modal, cloudflare, github, opencode
  index.ts      createInspect, localPorts
```

Import direction: `clients → index → {workspace, session} → {slot, agent, identity} → {ports, kernel}`.
Adapters implement ports only.

| Module | Owns | Does not own |
| --- | --- | --- |
| workspace | image cadence, pool, lease fencing, branch namespace, webhook→session | turn text, PR body |
| slot | freshness derivation, read vs mutate capability | prompt queue |
| session | queue, roster, event seq, stop, publish orchestration | VM boot policy |
| agent | runtime process, plugins, child spawn/status | persistence |
| authorship (in session) | Actor→UserToken exchange at publish | clone credentials |
| clients | transport translation | domain invariants |
