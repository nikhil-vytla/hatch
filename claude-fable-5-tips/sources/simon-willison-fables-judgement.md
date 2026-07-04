# Simon Willison — "Fable's judgement"

- Author: Simon Willison
- URL: https://simonwillison.net/2026/Jul/3/judgement/
- Fetched directly and confirmed (not reconstructed from search snippets).

## Summary (in my own words)

Willison relays advice from Claude Code team members on getting more out
of Fable 5 while burning through its token allowance more slowly ahead of
an expected price change. The central idea: stop giving Fable
prescriptive, step-by-step instructions and instead tell it to use its
own judgement — his example is testing strategy, where instead of
dictating when tests are required, you simply ask Fable to decide. He
pairs this with a delegation instruction: have Fable pick an
appropriately weaker/cheaper model for a given coding subtask and run
that subtask as a subagent, saving Fable's own reasoning for design,
review, and judgement calls. He reports this combination let him get
substantially more done while spending Fable tokens more slowly.

## Confirmed short quote

The specific instruction he documents having Claude Code use internally,
per the fetched page:

> "use your judgement to decide an appropriate lower power model"

(Trimmed from a longer sentence in the original; full context: this is
part of an instruction to delegate coding subtasks to subagents running
weaker models, chosen by Fable itself rather than hardcoded by the
user.)
