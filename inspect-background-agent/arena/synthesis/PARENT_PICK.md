# Parent pick (arena Phase D)

Read all four candidates end-to-end before scoring. Cross-judge running in parallel; this is the parent's independent score.

## Rubric scores (1–5)

| Criterion | C1 actor | C2 event-log | C3 capabilities | C4 workspace |
| --- | ---: | ---: | ---: | ---: |
| 1 Usage / no wire types | 5 | 5 | 4 | 5 |
| 2 Types encode lifecycle/gate/queue/authorship | 4 | 5 | 4 | 5 |
| 3 Ownership modules | 5 | 4 | 5 | 5 |
| 4 Interface depth (caller doesn't coordinate) | 5 | 4 | 4 | 5 |
| 5 Hatch fake adapters | 5 | 5 | 5 | 4 |
| 6 Honest red-flag self-check | 5 | 5 | 5 | 3 (late SELF_CHECK) |
| **Total** | **29** | **28** | **27** | **27** |

## Extensibility (tie-breaker)

- **C1**: Session DO maps 1:1 to Ramp Durable Objects. SandboxFleet privately owns pool/image. Future maintainer adds ports without widening SessionHandle. Clearest hatch path.
- **C2**: Best audit/replay, but gate-as-projection is a known risk; event schema becomes the forever API.
- **C3**: Best attenuation for plugins/webhooks; more objects for every client call site; private actor still exists (honest about that).
- **C4**: Deepest gate encoding (`admitWrites` / MutableSlot) and best home for warm pool/reaper. Cross-DO lease + fencing is too much mechanism for hatch v1; `dispatch` is excellent.

## Base

**Candidate 1 (session-as-actor).** Smallest public surface that still matches Ramp's "one SQLite per session" actor, with SandboxFleet hiding supply. Highest hatch implementability without giving up depth.

## Grafts into C1

From **C4**:
1. Type-encoded write gate: `admitWrites()` yields a mutable capability (or equivalent typed gate) instead of only a polled `gate()` enum — encode-lessons-in-structure.
2. `InstallationToken` vs `UserToken` brand split on push vs openPR.
3. Slack `dispatch` one-call as a hub helper (classify + find-or-create + enqueue), without making Workspace the root.

From **C3**:
4. Attenuated capability for agent plugins: spawn/status only, not full SessionHandle.
5. `rehydrate(sessionId, author)` for multiplayer join without sharing a live object.

From **C2**:
6. Pure `decide`/`evolve` (or transition) functions for queue/stop/idempotent PR with request keys — keep actor as writer, make transitions pure and tested.
7. Keep events as projection of actor state (C1 already), but adopt C2's stronger idempotency key discipline on every mutating intent.

## Rejected

- C4 as root aggregate for v1 (cross-DO leasing).
- C2 journal as sole source of truth for sync gate.
- C3 as primary public API (too many handles for Slack/web call sites).
- Exposing SandboxHandle lifecycle methods to clients.
- Interrupt-insert prompts; app-authored PRs.
