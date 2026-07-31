# Hard repo tasks: working notes

## Goal

Build and test an independent, rerunnable pipeline that extracts difficult,
novel agent tasks from public or private repositories without relying on code
memorization. The tasks should target system understanding, hidden behavioral
contracts, and cross-file reasoning, then export cleanly to HUD and Prime
Intellect Verifiers.

## Initial hypotheses

1. Familiar repositories can still yield novel tasks when the generator uses a
   pinned revision as raw material but derives counterfactual behavior,
   relational constraints, and hidden tests that never appeared in the
   repository or its issue history.
2. Frontier coding agents will struggle more with tasks whose evidence is
   distributed across architectural layers than with tasks made hard by context
   length alone.
3. A reward made from independent behavioral, regression, scope, and process
   checks will resist reward hacking better than a single test-suite pass bit.
4. Difficulty calibration needs empirical model rollouts. Static complexity
   heuristics alone will not reliably separate impossible, useful, and trivial
   tasks.

## Constraints

- This is a new top-level Hatch experiment.
- Do not modify or import code from `windtunnel`.
- Public and private local repositories are valid inputs.
- Never persist repository source, credentials, hidden tests, or gold patches
  in the committed experiment artifacts.
- Live HUD rollouts are part of the definition of done.

## 2026-07-31

- Read the current HUD v6 and Prime Intellect Verifiers v1 contracts.
- HUD uses async-generator task templates with prompt and grade yields, typed
  `Task` rows, structured subscores, and grouped rollout analysis.
- Verifiers v1 separates serialized `TaskData`, runtime-aware `Task`, iterable
  `Taskset`, and agent-driving `Env`. Private source belongs in pinned images,
  while hidden grading material stays evaluator-side.
- Existing Hatch work already explores deterministic synthetic worlds. This
  experiment will instead focus on extracting new behavioral tasks from real
  codebases and will remain independent.
- The key design problem is not finding old issues in a repository. Scraped
  repositories make that approach contamination-prone. The pipeline must
  synthesize a new latent contract, apply a controlled transformation, and
  derive graders from execution rather than reproduce known patches.
- Research baseline:
  - SWE-Smith generated 50,137 tasks, but its median task changed five lines
    and Claude 3.7 solved 36% overall. PR-mirror tasks produced the strongest
    downstream model among its task families.
  - SWE-rebench found a consistent multi-file penalty: DeepSeek-V3-0324 fell
    from 28.6% on one-file tasks to 17.5% on tasks touching three or more files.
  - SWE-bench Live reported less than 10% resolution above 100 changed lines or
    three files, and 0% for seven or more files in its initial study.
  - SWE-Mutation's semantic mutants cut test detection from 71.04% to 39.81%.
    This is strong evidence that "gold passes" is an inadequate oracle audit.
  - Cursor's strict single-commit, network-denied rerun reduced public benchmark
    scores by 14.1 to 20.7 points for two frontier agents. Runtime answer lookup
    is a measured failure mode, not a theoretical concern.
- Agent Behavior provides a useful separation between outcomes and recurring
  conduct. Initial task metadata tags repository grounding, scope control,
  focused testing, and fresh verification. Those behaviors should be judged
  from complete traces and should not be collapsed into the executable outcome
  reward until judge calibration exists.
- Selected architecture:
  - A recipe constructs a complete counterfactual world, then omits named edits
    to form the starter.
  - The public capsule and sealed evaluator capsule are separate.
  - Counterfactual contract checks are reward gates. Regression and adversarial
    checks cannot compensate for a failed contract.
  - Gold diffs validate generation but never grade candidate patch similarity.
- Cloned Click at `00e592cea702e0b2caa0dee42489fdb1c22cd845`
  into `/tmp`; no repository source will be committed.
- Built the first family around a new platform-adaptive `CliRunner` capture
  policy. It forces reasoning about Python-level versus file-descriptor-level
  capture and output ordering. Twelve generated mode names prevent a fixed
  upstream answer from satisfying the task.
- First `uv sync` failed because `pyproject.toml` referenced `README.md` before
  the report existed. Added the report skeleton and will retry.
