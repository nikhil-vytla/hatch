# Parallax autoresearch playbook

## Definition of done for cycle 1

Cycle 1 is verified when one command:

1. loads content-addressed source tasks;
2. generates static, matched no-change, reveal, revision, switch, and combined
   conversations;
3. runs one real HUD-routed model under a frozen model-call budget;
4. scores every final answer with the same executable verifier;
5. records one append-only JSONL row per rollout with task, condition, model,
   budget, response, reward, failure origin, and artifact hashes;
6. produces a paired condition summary from those rows;
7. runs one intent-ledger intervention against the hardest valid condition;
8. preserves setup and provider failures outside model-failure denominators.

The qualitative Evolving Intent effect is reproduced when at least one genuine
intent-change condition scores below the matched no-change control on the same
source tasks. This small prototype estimates direction, not significance.

## Scope

Cycle 1 uses three generated arithmetic knowledge-work tasks, six conditions,
two repetitions, and one inexpensive model. Static uses one model call. Every
other condition uses four calls. The matched no-change control is the primary
comparison for evolving conditions. The static arm measures the ordinary
single-turn capability ceiling.

The prototype does not yet:

- edit repositories;
- run shell tools;
- transform a source verifier;
- train model weights;
- claim statistical significance;
- reproduce the paper's complete GSM8K, SQL, search, or SWE results.

Those are later cycles after the measurement loop works.

## Frozen protocol

- Source-task generator version: `intent-arithmetic-v1`
- Conversation renderer version: `evolving-intent-v1`
- Conditions: `static`, `repeat`, `reveal`, `revision`, `switch`, `combined`
- Calls per non-static condition: 4
- Temperature and reasoning settings: provider defaults recorded in manifest
- Verifier: deterministic integer extraction and exact equality
- Analysis unit: source-task cluster
- Primary metric: exact final-answer success by condition
- Primary contrast: each evolving condition minus `repeat`
- Failure classes: `success`, `model_failure`, `provider_error`,
  `harness_error`, `invalid_response`

Changing a frozen field starts a new campaign ID. Existing rows are never
rewritten.

## Workflow

### Phase A: frame

- Freeze the campaign manifest and source-task records.
- Run local invariant tests before spending model calls.
- Confirm the matched control separates intent changes from conversation
  length.

### Phase B: baseline

- Run one smoke task through HUD Chat.
- Run all static and repeat controls.
- Stop if setup or provider failures exceed 10%.

### Phase C: perturb

- Run reveal, revision, switch, and combined conditions.
- Analyze paired deltas per source task.
- Inspect final answers and conversation traces for stale intent.

### Phase D: hill-climb

- Select the hardest valid condition.
- Add one explicit intent-ledger recap without changing model, task, call count,
  verifier, or source-task set.
- Keep the intervention only if it improves paired success without increasing
  invalid or provider failures.

### Phase E: learn and recurse

- Append the decision and evidence to `decisions.tsv`.
- Add source and synthesis notes to the knowledge graph.
- Choose one next axis based on observed failure:
  - no baseline competence: repair task difficulty;
  - repeat degradation: repair chat harness or budget;
  - revision degradation: test typed active-intent state;
  - switch degradation: test task-scoped memory or compaction;
  - no degradation: increase task depth before adding new mutation families.

## Rigor

This is a high-rigor prototype because incorrect measurement would steer every
later task generator and RL run. Gates are executable. The campaign manifest,
task records, rollout rows, and summary are committed. Model calls are the only
intentionally nondeterministic component.
