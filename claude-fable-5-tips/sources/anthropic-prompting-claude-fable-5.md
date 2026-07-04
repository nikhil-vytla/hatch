# Anthropic — "Prompting Claude Fable 5" (official docs)

- URL: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5
- Fetched directly and confirmed. This is the primary, authoritative
  source for this investigation — everything in
  [../templates/AGENTS.fable5.md](../templates/AGENTS.fable5.md) and
  [../templates/verifier-subagent-skill.md](../templates/verifier-subagent-skill.md)
  traces back to a section of this page.

## What the page covers

Anthropic's own guide to behavioral differences and prompting patterns
for Claude Fable 5 vs. Claude Opus 4.8, organized as one section per
behavior with a copy-pasteable instruction snippet for each:

- Capability improvements over Opus 4.8 (long-horizon autonomy, vision,
  enterprise workflows, code review/debugging, delegation).
- Longer turns by default — individual requests can run minutes,
  autonomous runs hours; adjust harness timeouts and avoid overplanning.
- Effort levels (`low`/`medium`/`high`/`xhigh`) as the primary
  capability/latency/cost dial.
- Strong instruction-following — brief principles work as well as
  enumerated rules, for both output brevity and checkpoint behavior.
- Grounding progress claims in tool results during long runs.
- Stating explicit boundaries on unrequested actions.
- Using parallel subagents more readily, asynchronously.
- Building a persistent memory system (one lesson per file).
- Rare early-stopping and context-budget-anxiety behaviors, and how to
  prevent them.
- Giving Fable the reason behind a request, not just the request.
- Writing final summaries for a reader who wasn't watching the work
  happen.
- A `send_to_user` tool pattern for surfacing verbatim content mid-task.
- Two things to actively remove from older prompts/skills: instructions
  to echo/transcribe reasoning as response text (can trigger a
  `reasoning_extraction` refusal), and overly prescriptive rules
  generally, since Fable 5 "does a good job of updating skills on the
  fly."

The functional prompt snippets themselves (the copy-pasteable
`text wrap` blocks in the original) are Anthropic's own instructional
templates, explicitly meant to be copied into a user's own
prompts/harnesses — those are reproduced in full in
[../templates/AGENTS.fable5.md](../templates/AGENTS.fable5.md), which is
the intended output of reading this page. This file only summarizes the
surrounding explanation.
