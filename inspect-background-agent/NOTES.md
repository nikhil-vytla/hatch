# Notes: Inspect-style background agent

Source: https://builders.ramp.com/post/why-we-built-our-background-agent

## Intent

Ramp's post is an explicit buildable spec ("paste the link into a coding agent and let it begin building"). Running `/architect` against it: ground the system, sketch competing designs, synthesize, then implement a hatch-scale replica that captures the architecture without pretending to be full production Ramp infra.

## Phase A grounding (from the article)

Greenfield relative to this hatch repo. No existing Inspect code to integrate. Constraints come from the published spec.

### Core product claims

- Background coding agent with full engineer context (tests, telemetry, feature flags, visual verify).
- Session in sandboxed VM (Modal) with full local-like stack.
- Speed: TTFT limited only by model provider; clone/install done ahead of time via images + snapshots.
- Multi-client + multiplayer: Slack, web, Chrome extension, PR comments, code-server; state synced.
- Authorship: PR opened with user's GitHub token, not the app.
- Adoption signal: ~30% of merged PRs from Inspect; voluntary adoption via Slack virality.

### Load-bearing subsystems

1. **Sandbox / image pipeline**
   - Per-repo image registry; rebuild ~every 30 min (clone, install, setup, optional warm run of app/tests).
   - GitHub App installation token for clone (not user-bound); rewrite git user.name/email on commit.
   - Session starts from snapshot; sync at most ~30 min of git delta.
   - On finish: snapshot again for resume after sandbox exit.
   - Warm on keystroke; optional warm pool per high-volume repo; expire pool on new image.
   - Agent may read files before sync completes; writes/edits blocked until sync done (OpenCode `tool.execute.before` plugin).
   - Prompt queue (not interrupt-insert); stop mid-run supported.
   - Child session spawn + status tools for fan-out research / smaller PRs.

2. **API / session state**
   - Cloudflare Durable Objects: one SQLite DB per session.
   - Agents SDK for realtime stream (sandbox ↔ API ↔ clients); WebSocket hibernation.
   - Multiplayer: multiple authors; attribute prompts that change code; don't bind session to single author.
   - Auth: GitHub OAuth preferred; sandbox pushes branch, API opens PR with user token.
   - GitHub webhooks for PR/branch lifecycle.

3. **Clients**
   - Slack: natural language, repo classifier (fast model + channel/thread context), status clarity, Block Kit, custom emojis, agent Slack message tool.
   - Web: desktop+mobile, code-server in sandbox, streamed desktop for computer use + screenshots to PR, org stats (merged PR rate, humans prompting last 5m).
   - Chrome extension: sidebar chat + DOM/React tree selection (not raw screenshot tokens); MDM force-install + update server.

4. **Agent runtime**
   - Strong recommend: OpenCode (server-first, typed SDK, plugins). Clients are thin.

### Non-goals for hatch experiment

- Real Modal billing / production Cloudflare account wiring.
- Full Ramp internal MCP set (Sentry, Datadog, LD, Braintrust, Buildkite).
- Chrome extension MDM distribution.
- Voice input.

### What "done" means here

A typed scaffold with: session domain model, sandbox lifecycle abstraction (fake + Modal-shaped interface), Durable Object / session actor API shape, OpenCode plugin hooks sketched, thin web + Slack client adapters, design rationale from arena synthesis. Runnable local demo with in-memory/fake sandbox preferred over cloud credentials.

## Arena framing (prep)

Artifact: design package (usage-first + type sketch + module map + rationale).
Rubric draft:
1. Usage shows multi-client session create → prompt → stream → PR without exposing Modal/DO/OpenCode wire types.
2. Types encode session lifecycle, authorship, sync gates (read-ok / write-blocked), and prompt queue.
3. Module map groups by ownership (Session, Sandbox, AgentRuntime, Clients), not by temporal pipeline steps.
4. Interface depth: callers don't coordinate warm/sync/snapshot themselves.
5. At least one structurally distinct alternative considered (e.g. session-as-job-queue vs session-as-actor).
6. Hatch-scale: implementable without Cloudflare/Modal accounts via ports/adapters.

## Arena outcome

Four candidates completed (A actor, B event-log, C capabilities, D workspace-first).

Parent first-pick: C1 (hatch simplicity, Ramp DO mapping).
Cross-judge pick: C4 (typed write gate, repo-scoped supply, deeper invariants).

**Resolved base: C4**, with C1's session mailbox grafted and cross-DO leasing simplified for hatch (in-process fencing). See `arena/synthesis/SYNTHESIS.md`.

## Implementation plan

1. Ship design package under `design/` (usage, sketch, modules, rationale with synthesis decision).
2. Implement packages: kernel, ports, workspace, session, adapters/local, thin clients.
3. Runnable local demo + tests for freshness gate and queue.

## Implementation

Implemented `@hatch/inspect` under `src/` against the synthesized design.

- Pure policy: `nextFreshness`, `advanceQueue`, `branchOfSession`, `toolEffect`
- Session mailbox serializes submit/stop/publish; events carry `EventOrigin`
- LocalSlot starts stale when base≠origin; `admitWrites` waits `syncDelayMs` then yields MutableSlot
- Agent stub reads before sync, parks mutating tools, writes after admit
- `publish` pushes with InstallationToken brand, opens PR with UserToken brand
- `dispatch` classifies repo from text/channel hints; ambiguous/unknown are first-class

Verification: `npm test` (7 passed), `npm run build`, `npm run demo` showed freshness park then PR URL.

No Phase E scrap: fill-in stayed within the sketch; hatch lease simplification was planned in synthesis.

## Follow-up research (Modal blog + CTO diagram + peers)

Sources added:
- https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal
- Ramp CTO Mermaid (Frontend / CF Worker DOs / Modal Python / Sandbox Runner+OpenCode+sidecars)
- Peers: Valet, enkaybit background-agents, Rafiki, Cursor Cloud Agents, Devin, Claude Code, Codex

Findings that changed the hatch model (not a scrap — planned refinement):
1. Control plane splits SessionAgent DO (durable SQLite) from EventBus DO (WS fan-out).
2. Modal Queue is prompt ingress; Dict holds locks/image metadata.
3. Bun Runner inside the sandbox is first-class: WS to DO, OpenCode HTTP, JWT proxy factory for code-server/VNC/ttyd.
4. Image recipes layer (base → webapp → core services → platform).
5. Adoption metric in Modal post: >50% merged PRs; 80%+ of Inspect written by Inspect.

Code updates: `control/event-bus`, `control/prompt-ingress`, `runner/` with sidecar URLs on SessionView; tests now 9.
