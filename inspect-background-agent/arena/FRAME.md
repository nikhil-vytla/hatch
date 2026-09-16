# Arena frame: Inspect-style background agent

## Artifact

Each candidate writes a design package to its output directory:

1. `USAGE.md` — caller's view first (quickstart + 2–3 realistic call sites)
2. `SKETCH.ts` — types, branded ids, function signatures, module boundaries; bodies `throw new Error("not implemented")` or `// TODO` pseudocode
3. `MODULES.md` — module map with ownership
4. `RATIONALE.md` — shaped exactly like `rationale-template.md` (leave "Synthesis decision" as "N/A — candidate sketch")
5. `SELF_CHECK.md` — short note screening against `design-red-flags.md` (shallow modules, leakage, temporal decomposition, pass-throughs)

## Shared grounding

Read `/workspace/inspect-background-agent/arena/GROUNDING.md` and the Ramp article summary in it. Source post: https://builders.ramp.com/post/why-we-built-our-background-agent

Also read:
- `/workspace/inspect-background-agent/arena/runner-prompt.md` (discipline)
- `/workspace/inspect-background-agent/arena/rationale-template.md`
- `/workspace/inspect-background-agent/arena/design-red-flags.md`

## Task

Design a hatch-scale TypeScript system that implements Ramp's Inspect architecture as ports/adapters:

Must cover:
- Session actor with per-session state (Durable Object–shaped), multiplayer authorship, prompt queue, stop
- Sandbox lifecycle: image snapshot boot, warm-on-keystroke, git sync gate (read early / block writes), resume snapshot
- Agent runtime integration point (OpenCode server-first): plugins for sync gate + Slack status tools + child session spawn
- API surface for multiple clients (web, Slack, future extension) with realtime event stream
- GitHub: push from sandbox, PR open with user token, webhook lifecycle hooks
- Local/fake adapters so the design runs without Modal or Cloudflare credentials

Deliberately omit: Chrome MDM, voice, full Ramp MCP suite (leave extension points).

## Structural diversity mandate

Candidates must explore **structurally distinct** shapes, not point variants. Suggested axes (pick a coherent whole-shape stance; do not try to cover all):

- **A — Session-as-actor**: one long-lived Session object owns queue, stream, sandbox handle, authorship. Clients are thin event sources.
- **B — Session-as-event-sourced log**: append-only event log is source of truth; projections for UI/agent; sandbox/agent are subscribers.
- **C — Capability-token session**: public API is capability objects (`PromptHandle`, `SandboxHandle`) minted by a factory; no god-session facade.
- **D — Workspace-first**: Workspace (repo+image+warm pool) is the root aggregate; Session is a short-lived lease on a workspace slot.

Announce your chosen axis in RATIONALE.md Shape section.

## Rubric (for judges; do not optimize to game it — optimize for a deep design)

1. Usage shows multi-client create → prompt → stream → PR without exposing Modal/DO/OpenCode wire types on the public surface.
2. Types encode session lifecycle, authorship, sync gates, and prompt queue (discriminated unions / brands preferred).
3. Modules group by ownership, not temporal pipeline stages.
4. Interface depth: callers do not coordinate warm/sync/snapshot themselves.
5. Hatch-scale ports/adapters for local fake backends.
6. Self-check against design red flags with honest findings.

## Runner discipline

Follow `runner-prompt.md` exactly. Caller's usage first. Differ from other runners on purpose — convergence on a safe middle defeats the arena.
