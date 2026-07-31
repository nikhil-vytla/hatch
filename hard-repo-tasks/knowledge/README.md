# Research knowledge system

This directory stores academic and practitioner research as small, typed notes
instead of one growing report. Each note has TOML front matter so humans can
read it, `rg` can search it, and scripts can validate its semantic links using
only the Python standard library.

## Layout

```text
knowledge/
├── index.md       Curated entry points and unresolved questions
├── concepts/      Stable definitions and distinctions
├── sources/       One note per paper, post, benchmark, or documentation set
├── syntheses/     Claims assembled across several sources
└── templates/     Copyable note templates, ignored by validation
```

Experiment observations remain in `../NOTES.md` and `../results/`. A knowledge
note may link to that evidence, but it must not rewrite an observation as an
established general result.

## Note contract

Every non-template note starts with TOML front matter:

```toml
+++
id = "concept.rl-environment"
kind = "concept"
title = "RL environment"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "environment-design"]

[relations]
broader = []
related = ["concept.rl-task"]
supported_by = ["source.sutton-barto-agent-environment"]
challenges = []
+++
```

IDs are stable and namespaced by kind. File paths may change without breaking
semantic links. Relation values always contain note IDs, never filenames.

Allowed kinds:

- `concept`: a definition or reusable distinction
- `source`: one external work and the claims actually supported by it
- `synthesis`: a conclusion drawn across sources or experiments
- `question`: an unresolved question with proposed tests

Allowed confidence values:

- `high`: direct primary evidence or repeated controlled evidence
- `medium`: supported synthesis with meaningful scope limits
- `low`: plausible hypothesis or thin evidence
- `unknown`: question not yet investigated

Status records lifecycle, not truth. Use `active`, `contested`, `superseded`, or
`archived`. A superseded note should link to its replacement.

## Writing rules

1. Create the source note before citing it from a concept or synthesis.
2. Record exact scope: models, harness, dataset, date, and sample size.
3. Separate a source's claims from our interpretation.
4. Put contradictions in `challenges`; do not silently average them away.
5. Use one concept per note. Link related concepts instead of duplicating them.
6. Mark hypotheses as hypotheses and include a falsification test.
7. Prefer primary sources. Label mirrors and secondary summaries.
8. Record access failures, including unavailable X posts.
9. Update synthesis notes when evidence changes. Do not rewrite source notes to
   fit a later conclusion.

## Search

```bash
# Full-text search.
rg -i "reward hacking" knowledge

# Find every note tagged with verifier design.
rg 'tags = .*"verifier-design"' knowledge

# Find notes supported by one source.
rg 'source\.cursor-strict-harness' knowledge

# Find contested claims.
rg 'status = "contested"|challenges = \[[^]]' knowledge

# Validate IDs, required metadata, and relation targets.
uv run python scripts/check_knowledge.py
```

## Review loop

For each research pass:

1. Frame the question and list the evidence needed.
2. Search primary sources and record inaccessible source categories.
3. Add or update source notes.
4. Update concepts only when definitions changed.
5. Add a synthesis that states evidence, inference, contradictions, and gaps.
6. Link implications to Parallax hypotheses or experiments.
7. Run the validator.
8. Append the operational learning to `../NOTES.md`.

The knowledge base is useful only if it can preserve disagreement. Its job is
not to produce one polished narrative. It should make the path from a design
claim to its sources, counterevidence, and experiments inspectable.
