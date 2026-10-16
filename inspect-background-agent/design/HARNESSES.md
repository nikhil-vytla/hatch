# Peer harnesses

Compared against Ramp Inspect after reading the [builders post](https://builders.ramp.com/post/why-we-built-our-background-agent), the [Modal customer story](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal), the CTO topology diagram, and public peers (mid‑2026).

## Shared pattern

Almost every serious background coding harness converges on:

1. **Isolated full env** (VM or container) so the agent can run tests, services, and browsers.
2. **Prebuilt images / snapshots** so TTFT is model-bound, not install-bound.
3. **Control plane outside the sandbox** for auth, multiplayer, and client fan-out.
4. **A thin in-sandbox supervisor** between the control plane and the coding agent.
5. **PR as the unit of delivery**, preferably authored as a human.

Where they diverge is ownership (self-hosted vs SaaS), verification depth (VNC/computer-use vs tests-only), and how aggressively they expose side cars to humans.

## Matrix

| Harness | Control plane | Compute | In-sandbox agent | Human side cars | Verification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **Ramp Inspect** | CF Worker, SessionAgent DO + EventBus DO, D1/R2 | Modal Sandboxes + Dict/Queue + 30m snapshot cron | OpenCode via Bun Runner | code-server, VNC+Chromium, ttyd (JWT tunnels) | Tests + telemetry + visual | Internal; ~50%+ merged PRs; multiplayer |
| **Valet** ([tkhq](https://github.com/tkhq/valet) / forks) | CF Worker + SessionAgent/EventBus/APIKeys DOs | Modal backend | Runner → OpenCode | code-server, VNC, ttyd, auth gateway | Same shape as Inspect | Self-hosted Inspect clone |
| **Open-Inspect / background-agents** | CF Workers + DOs | Modal or Daytona | OpenCode | Varies by fork | Snapshot warm start | OSS Inspect-inspired; single-tenant |
| **Rafiki** ([ibby-ai](https://github.com/ibby-ai/rafiki)) | CF DOs as ingress | Modal | Configurable (OpenAI Agents SDK cited) | Less Inspect-faithful | LangSmith eval hooks | Emphasizes hybrid auth contract |
| **Cursor Cloud Agents** | Cursor product control plane | Isolated Linux VMs (Firecracker-class), env snapshots | Cursor agent harness | IDE-native + artifacts | Build/test + computer use + video | SaaS (self-host enterprise option); multi-client |
| **Devin** | Cognition web/Slack | Full cloud VM | Devin runtime | Browser + editor + terminal | Session recording, browser QA | Productized coworker; expensive ACUs |
| **OpenAI Codex cloud** | ChatGPT / GitHub | OpenAI cloud sandbox | Codex | Limited | Tests / diff | Narrower side-car story |
| **Claude Code** | Local CLI (+ remote control) | Local machine / worktrees | Claude Code | Terminal | Tests locally | Opposite bet: depth on one laptop, not N cloud envs |

## Design takeaways we adopted

- **Split SessionAgent vs EventBus.** Valet and the CTO diagram agree; our hatch `control/event-bus` mirrors that.
- **Runner is a product surface, not glue.** JWT proxy factory + OpenCode HTTP + DO WebSocket live here. Without it you cannot ship VS Code/VNC iframes safely.
- **Queue outside the sandbox.** Modal Dict/Queue (and Cursor's env pool) keep multiplayer submit alive while compute is cold or syncing.
- **Side cars are how non-engineers enter.** Chrome extension + VNC + code-server are not polish; they are the adoption loop the Modal post credits for PMs/designers.
- **Verification closes the agency loop.** Inspect's Sentry/Datadog/LaunchDarkly/Buildkite wiring and VNC screenshots match Cursor's "environment is the product" thesis. Our hatch leaves MCP hooks on the agent port.

## Design takeaways we rejected for hatch v1

- Full VNC/Xvfb stack in CI (heavy). We expose `ideUrl` / `vncUrl` / `ttyUrl` fields and fake them locally.
- Daytona as a second compute backend (Open-Inspect). One `ComputePort` is enough until a second adapter exists.
- Claude Code's local-only bet. Wrong fit for unlimited concurrency and zero-setup builders.

## References

- https://builders.ramp.com/post/why-we-built-our-background-agent
- https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal
- https://github.com/tkhq/valet
- https://github.com/yourbuddyconner/valet
- https://github.com/enkaybit/background-agents
- https://github.com/ibby-ai/rafiki
- https://cursor.com/docs/cloud-agent
- https://opencode.ai/
