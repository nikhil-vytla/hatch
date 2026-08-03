# Arena synthesis note

## Base

**Candidate 4 (workspace-first)**, agreeing with the cross-judge over the parent's first pick (candidate 1).

Parent scored C1 highest on hatch simplicity and self-check honesty. Cross-judge scored C4 deeper on the write gate (typed `admitWrites` / `MutableSlot`), repo-scoped supply (pool, image, reaper), and invariants that typecheck rather than rely on plugin discipline. Disagreement was real: C1 totals won by the missing C4 `SELF_CHECK.md`, not by design depth. On criteria that measure the shape, C4 leads. Extending C1 later into a workspace aggregate under production load is the expensive migration; writing a self-check for C4 is cheap.

## Grafts

| From | Graft | Why |
| --- | --- | --- |
| C1 | Session command mailbox + `SessionStore` | Makes "one writer per session" concrete and DO-shaped |
| C1 | `childStatus` on agent capabilities | Fan-out without a blind spawn |
| C2 | `EffectId` on provider ports | Crash/retry window around boot, push, PR open |
| C2 | `EventOrigin` on session events | Multiplayer transcript provenance |
| C3 | Attenuated read grant for browser SSE | Stream without submit/publish authority |
| C3 | `ideUrl` on session view | Article's code-server surface |
| C1 (usage) | Keep hub-style warmHint at Inspect/Workspace | Already in C4 as `ws.hint` |

## Rejected

- C3 raw `userGithubToken: string` on public PR open
- C2 command/`Record*` layer as source of truth for the gate
- C1 polling `caps.gate()` as the write block
- Averaging all four axes into one composite

## Hatch simplification (planned breakage during fill-in)

Cross-DO leasing is deferred. Local and first cloud adapters keep Workspace and Session in-process (or one store namespace); lease epochs still exist as data, but fencing is a local compare-and-swap, not two Durable Objects. Production DO split remains a port swap.

## Verification

Synthesized package lives in `/workspace/inspect-background-agent/design/`. Implementation fills `not implemented` against that contract.
