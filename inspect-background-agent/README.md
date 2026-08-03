# Inspect-style background agent

A hatch-scale implementation of Ramp's Inspect, designed with `/architect` and refined against the [Modal deep-dive](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal) and the CTO topology diagram (control plane / Modal orchestration / sandbox Runner).

## What it is

Inspect's thesis: a hosted coding agent is only as good as the environment and verification loop around the model. Sessions run in full sandboxes, boot from warm images, allow file reads before git sync finishes, block writes until sync completes, queue prompts instead of interrupting, open PRs as the human, and show up wherever the team already works.

This package is a typed ports/adapters replica. Local adapters stand in for Cloudflare Durable Objects, Modal Dict/Queue, and the in-sandbox Bun Runner so you can run create → prompt → stream → PR without cloud credentials.

## Three planes

```
Control (CF)     SessionAgent DO + EventBus DO + D1/R2
Orchestration    Modal Session/Sandbox managers, image layers, Dict, Queue
Execution        Runner → OpenCode + code-server / VNC / ttyd (JWT tunnels)
```

Details: [`design/TOPOLOGY.md`](design/TOPOLOGY.md), diagram: [`design/ramp-cto-topology.mmd`](design/ramp-cto-topology.mmd). Peer comparison (Valet, Open-Inspect, Cursor Cloud, Devin, Claude Code): [`design/HARNESSES.md`](design/HARNESSES.md).

## Architecture (synthesized)

Arena picked **workspace-first** for the orchestration plane (repo owns images/pool/leases). Refinement after the CTO diagram:

- SessionAgent-shaped mailbox for durable turns
- EventBus fan-out separate from persistence
- PromptIngress (Modal Queue–shaped) for multiplayer enqueue while cold
- Runner as the only bridge to the agent + sidecar URL minting
- Typed `admitWrites()` write gate; `InstallationToken` vs `UserToken`

## Run

```bash
cd inspect-background-agent
npm install
npm test
npm run demo
```

## Layout

```
design/          usage, sketch, modules, rationale, topology, harness survey
arena/           grounding + four candidate packages + synthesis
src/
  control/       event-bus, prompt-ingress
  workspace/     orchestration / supply
  slot/          freshness + leased vs mutable slot
  session/       SessionAgent–shaped mailbox
  runner/        in-sandbox supervisor + scripted agent
  adapters/local in-process CF+Modal+sandbox stand-ins
tests/           9 tests (policy, E2E, bus, ingress)
```
