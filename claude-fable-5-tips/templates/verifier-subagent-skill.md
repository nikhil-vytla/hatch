---
name: verify-progress
description: Periodically audit long-running work against the original spec using a fresh-context subagent, rather than self-critiquing. Use for autonomous or long-horizon tasks (many tool calls, multi-stage plans) where progress claims need grounding.
---

# Verify progress

Implements Anthropic's recommended self-verification pattern for Fable-class
models: a separate, fresh-context verifier subagent tends to catch problems
that self-critique misses, because it isn't anchored to the same
assumptions the implementing agent has built up.

## When to run this

- On long-running or multi-stage tasks, at a natural checkpoint interval
  (e.g. after each major milestone, or every N tool calls/minutes —
  whichever the task defines).
- Before reporting "done" on any task where the user won't be watching in
  real time.

## How to run it

1. Write down the original spec/goal and what you believe is done so far,
   in concrete, falsifiable terms (files changed, commands that should
   pass, behaviors that should work).
2. Dispatch a subagent with **no memory of your working session** — give
   it only: the original spec, the current state of the repo/artifacts,
   and the claim to verify. Do not hand it your reasoning or summary of
   progress; let it check independently.
3. Ask the subagent to actually execute verification (run tests, inspect
   files, reproduce the behavior) rather than reason about whether it
   *should* work.
4. Treat disagreements between your claim and the subagent's finding as
   real signal — investigate rather than defaulting to your own account.

## Prompt template for the verifier subagent

```text
You are verifying work done by another agent. You have no context beyond
what's given here. Spec: [paste spec]. Claim: [paste specific claim to
verify, e.g. "all tests pass" or "the API returns X for input Y"].
Verify this by actually running/inspecting things yourself — do not take
the claim on faith. Report: confirmed, or not confirmed with the specific
evidence that contradicts it.
```

## Prompt template for grounding your own progress claims (no subagent needed)

```text
Before reporting progress, audit each claim against a tool result from
this session. Only report work you can point to evidence for; if
something is not yet verified, say so explicitly.
```
