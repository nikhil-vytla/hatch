# ADR-0007 — Model & provider integration: one client method, one policy

**Status:** accepted · 2026-07-04

## Context

The platform must run *any* agent — any model, any provider, eventually any
SDK — as the system-under-test without rewriting worlds. Prior to this ADR,
only rule-based in-process policies existed, so "provider-agnostic" was an
unproven claim.

## Decision

Two pieces, deliberately minimal:

1. **`ModelClient` protocol** — one async method:
   `complete(system, messages, tools) -> ModelResponse{text, tool_calls}`.
   A provider is anything implementing it: `AnthropicClient` ships (~40
   lines, lazy import, optional dependency); an OpenAI-compatible or local
   adapter is symmetric; `PlaybookClient` (deterministic scripted responses)
   is both the test double and the reference implementation.
2. **`ModelPolicy`** — turns any client into an actor. One model call per
   activation; a provider-neutral action toolset (`send_message`,
   `call_tool`, `set_fact`) maps model tool calls onto kernel intents; tool
   results arrive as the *next* observation via reaction rules. There is no
   inner agentic loop — the kernel's event loop IS the agentic loop, which
   keeps chaos, budgets, and multi-agent interleaving applicable to model
   turns for free.

**Replay isolation is the payoff of ADR-0001:** decisions are recorded, so
replaying a model-driven trace never constructs a request to any provider —
proven by a test that replays against a client that raises on contact.

## Alternatives considered

- *Per-provider policies* (`AnthropicPolicy`, `OpenAIPolicy`, …) — N providers
  × M policy behaviors; rejected for the classic adapter-matrix reason.
- *Depend on litellm/langchain for provider abstraction* — large dependency
  surface for one method's worth of abstraction; easy to add later *behind*
  `ModelClient` if needed.
- *Inner tool-use loop inside `decide()`* (call model until it stops calling
  tools) — hides multiple world interactions inside one decision, which would
  blind the scheduler, budget verifiers, and chaos windows to intermediate
  calls. The event-driven shape keeps every tool call a first-class,
  perturbable, verifiable event.

## Consequences & accepted simplifications

- Conversation history is stored as plain text turns (tool calls serialized
  inline) in actor-private memory. Provider-portable and replay-safe, but it
  loses native tool-use message structure, which reduces fidelity for strong
  tool-calling models. Fix when it bites: store structured turns and let each
  client render them natively (interface unchanged). Logged as debt.
- One model call per activation means a model that wants to chain two tool
  calls does so across two activations. Correct, slightly chattier traces.
- The T2 interception proxy (ADR-0005) remains the end-state for *unmodified
  agent binaries*; `ModelClient` covers the "bring your model" tier today.
