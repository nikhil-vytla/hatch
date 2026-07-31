+++
id = "source.microsoft-evolving-intent"
kind = "source"
title = "LLMs Get Lost in Evolving User Intent"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["evolving-intent", "multi-turn", "task-variation", "agents"]
source_type = "paper-and-code"
authors = ["Jihoon Tack", "Philippe Laban", "Jennifer Neville"]
year = 2026
url = "https://arxiv.org/abs/2607.20734"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.deepswe", "source.hud-task-design"]
supported_by = []
challenges = []
+++

# LLMs Get Lost in Evolving User Intent

Code: [microsoft/evolving-intent](https://github.com/microsoft/evolving-intent)
at `993d6be9597ac03854b46362ccd647eb1bfd267a`.

## Why it matters

The paper turns static benchmark tasks into controlled multi-turn intent
trajectories while retaining the original final evaluator. It offers a way to
study intent tracking without authoring a new terminal answer for every
conversation.

## Supported claims

### C1. Backward construction preserves the terminal anchor

The pipeline decomposes the source task into a function and arguments, creates
reveal, revision, and predecessor events, then schedules them so the final
latent intent restores the original function and source argument values. The
original benchmark verifier scores only the final answer.

### C2. Function switching is harder than reveal or revision in the study

Across the reported domains and models, transitions involving function
switching produced the largest degradation. Repeated turns without intent
changes did not explain the full loss.

### C3. Final verifiability does not imply intermediate validity

The original verifier checks the terminal answer. It does not establish that
intermediate responses were correct, safe, or free of destructive side
effects.

## Methods and implementation

The paper evaluates GSM8K, BIRD-SQL, BrowseComp+, and 50 SWE-bench Verified
instances. The code separates:

- intent extraction,
- counterfactual argument generation,
- predecessor generation,
- plan-first scheduling,
- turn rendering,
- model execution,
- native final evaluation.

Core implementation paths include:

- `situated_simulation/user_intent.py`
- `situated_simulation/turn_scheduler.py`
- `intent_construction/retrospective_expansion/`
- `evaluation/common/swe_harness.py`

The SWE path uses planning and orientation precursors because persistent code
edits from obsolete tasks would invalidate simple anchor equivalence.

## Limitations

- Exact evaluation exists only at the final turn.
- Many extraction and independence checks use an LLM judge.
- Generated conversations and paper result files are not included in the
  repository, so source subsets are reproducible but exact conversations are
  not.
- Stateful work introduces non-commutative and irreversible effects.
- Current code and paper settings differ in some SWE tool budgets.
- The selected task subset favors instances that admit extraction,
  counterfactuals, and predecessor chains.

## Parallax implications

Reuse the backward anchor construction, structured event plan, and original
terminal verifier only for read-only or staged read-only-to-transactional
precursors. Persistent edits require an episode-aware verifier and must be a
separate task family.
