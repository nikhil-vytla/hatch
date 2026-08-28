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
