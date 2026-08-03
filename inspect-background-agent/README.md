# Inspect-style background agent

A hatch-scale implementation of Ramp's [Inspect background coding agent](https://builders.ramp.com/post/why-we-built-our-background-agent), designed with `/architect` (ground → arena → synthesize → implement).

## What it is

Inspect's thesis: a hosted coding agent is only as good as the environment and verification loop around the model. Sessions run in full sandboxes, boot from warm images, allow file reads before git sync finishes, block writes until sync completes, queue prompts instead of interrupting, open PRs as the human, and show up wherever the team already works (Slack, web, etc.).

This package is a typed ports/adapters replica of that shape. Local adapters use in-memory slots with a configurable sync delay so you can run create → prompt → stream → PR without Modal, Cloudflare, or GitHub credentials.

## Architecture (synthesized)

Four arena candidates explored whole-shape alternatives:

| Axis | Idea | Outcome |
| --- | --- | --- |
| A Session-as-actor | One DO-shaped actor per session | Grafted mailbox into the base |
| B Event-sourced log | Journal as source of truth | Rejected as gate authority; kept EffectId / provenance ideas |
| C Capability tokens | Narrow handles, no god-session | Attenuation kept for agent plugins / read grants |
| D Workspace-first | Repo aggregate owns pool/images; session is a lease | **Base** |

Public surface: `Inspect` → `Workspace` → `Session`. The write gate is typed (`admitWrites()` yields a mutable slot). Clone/push uses `InstallationToken`; PR open uses `UserToken`. Callers pass `Actor`, not secrets.

Design package: [`design/`](design/). Arena record: [`arena/synthesis/`](arena/synthesis/).

## Run

```bash
cd inspect-background-agent
npm install
npm test
npm run demo
```

## Layout

```
design/          synthesized usage, sketch, modules, rationale
arena/           grounding, four candidate packages, synthesis
src/
  kernel/        brands, clock
  identity/      actors, conversation refs
  slot/          freshness, tool effect, leased vs mutable slot
  session/       mailbox, queue, events, publish
  workspace/     root aggregate, local slot acquisition
  adapters/local credential-free wiring + Slack-shaped dispatch
tests/           pure policy + end-to-end local flow
scripts/demo.ts  CLI walkthrough
```

## Limits (deliberate)

No real Modal sandboxes, Durable Objects, OpenCode server, Chrome extension, or voice. Warm pool sizing and cross-DO lease fencing are modeled in types/policy but simplified in-process for hatch. Extension points match the Ramp article when you swap adapters.
