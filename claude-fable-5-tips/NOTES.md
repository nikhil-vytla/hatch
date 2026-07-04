# NOTES — Claude Fable 5 tips investigation

## Goal
Distill trusted guidance on how to work with Claude Fable 5 into reusable
artifacts (AGENTS.md snippet + skill), starting from a specific tweet and
blog post the user pointed at, then corroborating with primary sources.

## Sources tried

1. `https://x.com/trq212/status/2073100352921215386` (Thariq, Anthropic)
   - Direct WebFetch failed: HTTP 402 Payment Required (x.com gating).
   - Recovered via web search instead. Thariq's recurring theme across
     several posts in this thread/series: "Fable is a step-change... time
     to be more ambitious", and specifically telling Fable to "use your
     judgement to decide an appropriate lower power model and run that in
     a subagent" for coding tasks. General idea: stop treating Fable like
     autocomplete; reserve it for judgement (architecture, migration
     planning, complex debugging, final review), delegate mechanical work
     to cheaper models.

2. `https://simonwillison.net/2026/Jul/3/judgement/` ("Fable's Judgement")
   - WebFetch worked directly.
   - Core point: let the model use its own judgement rather than
     micromanaging ("use its own judgement when deciding to write tests"
     instead of prescriptive rules). Delegate implementation to
     cheaper/faster models (Sonnet/Haiku) via subagents to conserve
     expensive Fable tokens; keep Fable for design/audit/synthesis/review.
     Reports this sped up work while slowing token burn ahead of
     anticipated price changes.

3. Anthropic official docs (found via web search, fetched directly):
   - `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5`
     — THE primary source. Very concrete, with copy-pasteable prompt
     snippets for each behavior. See distilled list in README.md.
   - `https://www.anthropic.com/news/claude-fable-5-mythos-5` — capability
     announcement: 1M token context, $10/$50 per Mtok pricing, safety
     classifier fallback to Opus 4.8 (~<5% of sessions), 30-day retention
     for Mythos-class traffic.

4. Web search sweep for secondary commentary (product blogs, Medium,
   TechCrunch) — mostly restated the same points as the official doc with
   less precision; not worth citing individually. Skipped fetching these
   in full to avoid noise/duplication.

## Key observation / connection back to this repo

The current [Claude Code system prompt](../CLAUDE.md) already contains
language nearly identical to two of the official Fable 5 prompting
patterns:
- "When you have enough information to act, act. Do not re-derive facts
  already established..." (matches the official "longer turns by default"
  snippet almost verbatim)
- "Don't add features, refactor, or introduce abstractions beyond what
  the task requires..." (matches the official "consider all effort
  levels" snippet almost verbatim)

This suggests Claude Code's harness prompt has already absorbed these
Fable 5-era recommendations — so a lot of this guidance is "free" if
you're already using Claude Code, but is worth carrying explicitly into
project-level AGENTS.md/CLAUDE.md files and custom harnesses (e.g. the
Streamlit agent in meta-agent-eval-system) that don't inherit it.

## What I built

- `templates/AGENTS.fable5.md` — a copy-pasteable AGENTS.md/CLAUDE.md
  addendum distilling the official guidance into instruction blocks,
  organized by theme (judgement, delegation, grounding, communication).
- `templates/verifier-subagent-skill.md` — a small skill definition
  implementing the "separate fresh-context verifier subagent" pattern
  Anthropic recommends for long-running self-verification.

## Verification pass (second session)

Re-verified independently before committing, since this folder already
existed uncommitted when this session started and I didn't want to trust
it blindly:
- Chrome extension was not connected in this session (tab access failed
  repeatedly), so couldn't re-read the tweet in-browser as the user
  suggested. Fell back to WebFetch/WebSearch.
- Re-fetched `simonwillison.net/2026/Jul/3/judgement/` directly — content
  matches the notes above (same "use your judgement to decide an
  appropriate lower power model and run that in a subagent" quote,
  attributed to a Claude Code team member).
- Re-fetched the official Anthropic prompting doc in full — every pattern
  cited in README.md/templates traces to an actual section of that page
  (longer turns, effort levels, instruction following, grounding progress
  claims, boundaries, subagents, memory, early stopping, context-budget
  countdown, reasoning-extraction refusal, send-to-user tool). No
  fabricated claims found.
- Confirmed `anthropic.com/news/claude-fable-5-mythos-5` is a real,
  separate page (distinct from the platform.claude.com docs page) with
  matching pricing ($10/$50 per Mtok) and rollout details.
- `https://x.com/trq212/status/2073100352921215386` still 402s on direct
  fetch, but a targeted search on the literal status ID confirms the post
  exists and is attributed to @trq212 — consistent with treating the
  NOTES/README paraphrase as unverified-verbatim but correctly sourced.

## Open questions / things not verified
- Could not confirm the *exact* wording of the trq212 tweet since x.com
  blocked the fetch (402). Reconstructed via search snippets from
  multiple secondary sources quoting it, so treat as paraphrase, not
  verbatim quote.
- Didn't fetch every product-blog hit from search (many looked like SEO
  content farming the Fable 5 launch) — official Anthropic docs are the
  trustworthy source and secondary posts added no new substance in the
  snippets I checked.
