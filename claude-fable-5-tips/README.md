# Working with Claude Fable 5: distilled tips

A small investigation into how to prompt and build harnesses for Claude
Fable 5, starting from a [tweet by Thariq (Anthropic)](https://x.com/trq212/status/2073100352921215386)
and [Simon Willison's "Fable's judgement"](https://simonwillison.net/2026/Jul/3/judgement/),
then corroborated against Anthropic's official prompting docs.

## TL;DR

Fable 5 is capable enough that older, prescriptive prompting habits
(enumerated rules, micromanaged checkpoints, treating it like autocomplete)
actively hold it back. The consistent advice across every source: **give
it judgement and intent, not rules; delegate mechanical work to cheaper
subagents; and ground its self-reported progress in evidence.**

## Sources

- [Thariq (@trq212) on X](https://x.com/trq212/status/2073100352921215386) —
  direct fetch was blocked (HTTP 402 on x.com), reconstructed via search
  snippets of this and adjacent posts in the same thread. Consistent
  theme: "use your judgement to decide an appropriate lower power model
  and run that in a subagent" for coding tasks — stop using Fable like
  autocomplete, use it for judgement (architecture, migration planning,
  debugging, review).
- [Simon Willison — "Fable's judgement"](https://simonwillison.net/2026/Jul/3/judgement/) —
  same delegation idea from the user side: tell Fable to use its own
  judgement (e.g. on when to write tests) instead of prescriptive rules,
  and to delegate implementation to cheaper models to conserve Fable
  tokens. Reports faster output with slower token burn.
- [Anthropic — Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) —
  the primary source; official, detailed, with copy-pasteable prompt
  snippets. Everything below traces back to this doc unless noted.
- [Anthropic — Introducing Claude Fable 5 and Claude Mythos 5](https://www.anthropic.com/news/claude-fable-5-mythos-5) —
  capability/pricing context: 1M token context window, $10/$50 per Mtok,
  safety-classifier fallback to Opus 4.8 in <5% of sessions.

## Key findings

**1. Judgement over rules.** Instructions written for older models keep
Fable behaving like those older models. Prescriptive, enumerated rules
should be replaced with a judgement call plus the reasoning behind it.

**2. Delegate to conserve capability, not just cost.** Fable is
"significantly more dependable at dispatching and sustaining parallel
subagents." Use it as architect/reviewer, push implementation to
Sonnet/Haiku subagents, and prefer async delegation over blocking on each
subagent.

**3. Longer turns are the default, not an edge case.** Individual requests
can run for many minutes; autonomous runs can extend for hours. Harnesses
need to adjust timeouts and check on runs asynchronously rather than
blocking. Left unsteered, Fable can also overplan on ambiguous tasks — a
short "act once you have enough information" instruction fixes this.

**4. Instruction-following is strong enough that brevity works.** A short
principle steers behavior as well as an enumerated list of cases. This
applies to both output style (brevity) and to checkpoint/pause behavior
(when to stop and ask the user).

**5. Ground long-run progress claims in tool results.** Explicitly
instructing Fable to audit each progress claim against a real tool result
"nearly eliminated fabricated status reports" in Anthropic's own testing.

**6. State boundaries explicitly.** Fable can take unrequested actions
(drafting unsolicited emails, defensive git branches). Explicit
constraints on what counts as "thinking out loud" vs. "asking for a
change" curb this.

**7. Give memory a place to live.** Fable "performs particularly well
when it can record lessons from previous runs" — even a plain Markdown
file with one lesson per file works, and Fable can bootstrap it by
reviewing past sessions itself.

**8. Effort is the main capability/cost/latency dial.** Use `high` by
default, `xhigh` for the hardest work, `medium`/`low` for routine tasks —
Fable at low effort can still beat prior models at max effort.

**9. Two things to actively remove from old skills/prompts:**
   - Don't ask Fable to echo or transcribe its reasoning into
     user-facing text — this can trigger a `reasoning_extraction` safety
     refusal and fall back to Opus 4.8. Use structured `thinking` blocks
     or a dedicated send-to-user tool instead.
   - Don't surface a live remaining-context countdown — it can trigger
     premature "should we start a new session?" suggestions.

## Connection back to this repo

The top-level [CLAUDE.md](../CLAUDE.md) (via Claude Code's own system
prompt) already contains language that's nearly verbatim two of these
official patterns — "when you have enough information to act, act" and
"don't add features/refactor beyond what the task requires." That's a
sign these recommendations are already baked into Claude Code's harness
by default. The gap is in project-specific AGENTS.md files and custom
harnesses (e.g. this repo's `meta-agent-eval-system`, which runs its own
Streamlit-based agent loop) — those need the guidance added explicitly,
since they don't inherit Claude Code's system prompt.

## What's in this folder

- [NOTES.md](NOTES.md) — working notes, including sources that didn't
  pan out and why.
- [templates/AGENTS.fable5.md](templates/AGENTS.fable5.md) — copy-pasteable
  AGENTS.md/CLAUDE.md addendum with the instruction blocks above, ready
  to drop into a project.
- [templates/verifier-subagent-skill.md](templates/verifier-subagent-skill.md) —
  a skill definition implementing Anthropic's recommended
  fresh-context-verifier pattern for long-running self-verification.
