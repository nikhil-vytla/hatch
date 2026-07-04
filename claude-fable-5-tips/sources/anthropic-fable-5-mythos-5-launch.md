# Anthropic — "Claude Fable 5 and Claude Mythos 5" (launch announcement)

- URL: https://www.anthropic.com/news/claude-fable-5-mythos-5
- Docs-site counterpart with the same content:
  https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5
- Confirmed via web search (title, pricing, and rollout details
  cross-checked against independent press coverage of the same launch —
  TechCrunch, CNBC, Yahoo Finance — which is consistent).

## Summary (in my own words)

Announces general availability of Claude Fable 5, described as
Anthropic's most capable publicly-available model at launch, alongside a
separate, more restricted sibling model (Claude Mythos 5) made available
only to a small group of cyberdefenders and infrastructure providers via
"Project Glasswing," a collaboration with the US government. Fable 5 and
Mythos 5 share the same underlying model; Mythos 5 has some safeguards
lifted for that vetted use case.

## Concrete details relevant to this investigation

- Context window: 1M tokens by default (no beta header needed), up to
  128K output tokens per request; billed at standard per-token rates
  with no long-context premium. Confirmed via a separate web search
  cross-checking multiple independent sources (OpenRouter's model page,
  Anthropic's own context-windows docs).
- Pricing: $10 / $50 per million input/output tokens — double Opus 4.8's
  pricing.
- Included at no extra cost on Pro/Max/Team/seat-based Enterprise plans
  only for a limited window after launch, then usage-credit-gated on
  those plans; fully available from launch on the API and
  consumption-based Enterprise plans.
- Safety classifiers cover offensive cybersecurity, biology/life-sciences
  content, and extraction of the model's summarized thinking; declines in
  these areas can be routed to a Claude Opus 4.8 fallback.

This context matters for the prompting guidance in
[anthropic-prompting-claude-fable-5.md](anthropic-prompting-claude-fable-5.md):
the "ground progress claims" and "avoid reasoning-extraction triggers"
patterns exist specifically because of these safety classifiers and the
Opus 4.8 fallback behavior described here.
