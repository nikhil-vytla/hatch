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
- Implemented a standard-library compiler with exact pinned text edits, separate
  public/sealed capsules, deterministic hashes, executable admission, gated
  grading, and HUD/Verifiers exports.
- All 12 Click tasks passed the admission matrix twice: deterministic output,
  gold=1, no-op=0, upstream restoration=0, and unrelated-path tampering=0.
- First HUD no-op lifecycle returned a structured zero with regression=1,
  counterfactual=0, adversarial=1. This confirmed that the contract gate works.
- Live rollout attempt 1:
  - Scheduled six DeepSeek-V4-Flash and six Claude Sonnet 4.6 runs across three
    omission depths.
  - HUD's local macOS workspace warned that bubblewrap was unavailable. Agents
    ran broad `find /` and host-directory commands; several hung.
  - Stopped only the runaway commands. Five initial DeepSeek runs completed with
    rewards `[0, 0, 1, 0, 0]`; the remaining runs were not clean enough for a
    model comparison.
  - One successful DeepSeek trace used a minimal inline dispatch condition and
    recovered from importing Click out of a stale editable checkout.
- Built and deployed the HUD image successfully:
  - Build `a5bc3aac-7a34-49bc-b4a5-68b3e47f9840`
  - Image digest
    `sha256:fb6252115437f5d2754a268b850cb20efb9eaaff957ce9e76988af420c1f6567`
  - v6 introspection found one task template and two capabilities.
- Remote execution remained unavailable:
  - `--runtime hud` returned HTTP 404 from the runtime-session endpoint for all
    12 attempted runs.
  - Fully hosted submission returned "No registry found" for two smoke runs,
    even though the image deployment succeeded.
- Tightened local prompt/workspace guidance and ran serial calibration:
  - GPT-5.6 Sol passed the semantic contract in 4/4 audited completed runs.
    Three scored 1. The fourth scored 0 only because it added focused tests.
  - Three representative DeepSeek traces passed all nine semantic component
    checks but scored 0 under the old integrity policy.
  - Claude Sonnet 4.6 hit a 300-second provider idle timeout and was excluded.
- Reward-policy correction:
  - The original `allowed_paths` excluded `tests/test_testing.py`. This punished
    agents for adding legitimate regression tests even when hidden behavioral
    checks all passed.
  - Setting `HOME` to the workspace caused normal pip cache files to appear as
    modifications and trip the same gate.
  - Revised recipes allow the focused test file. Grading now filters only
    narrowly defined pytest, bytecode, coverage, and pip cache artifacts.
  - This is an example of reward design changing the behavior selected by RL:
    the old rule preferred minimal patches over evidence-producing engineering.
- Containment breach:
  - The unisolated model modified `/tmp/parallax-click`, a separate source clone
    outside its task workspace.
  - Saved the diff as `results/escaped-workspace-click.diff`, deleted the
    disposable clone, and recreated the exact pinned revision.
  - Local macOS HUD results are unacceptable for production until they run
    inside a container or another hard filesystem boundary.
- Difficulty conclusion:
  - The counterfactual successfully resists memorized upstream restoration.
  - It is not hard: the complete feature reduces to validation plus dispatch,
    and both the strong and inspected weak rollouts solved it.
  - Counterfactuality and hardness are independent axes. The family is rejected
    by the calibration controller and must be hardened with cross-module state,
    temporal sequences, and adversarial semantic mutants.
- Verifiers integration:
  - PyPI `verifiers==0.2.1` lacks the documented `verifiers.v1` namespace.
  - Current main at
    `b4612b53ae911c2295c56ab31c9fb1d9f9dde061` reports
    `0.2.2.dev58` and exposes v1 under `import verifiers.v1 as vf`.
  - Corrected the adapter for typed `TaskData`, behavioral `Task`, and lazy
    `Taskset`. It loads all 12 generated rows against that pinned API.
- Final verification:
  - `uv run pytest -q`: 5 passed.
  - `uv run ruff check .`: all checks passed.
  - The admission matrix rerun passed all five checks for all 12 tasks.
  - The generated taskset loaded all 12 rows against Verifiers v1.
- Environment and task research:
  - Added `RL_ENVIRONMENT_KNOWLEDGE_BASE.md` so conceptual research does not
    remain trapped in chat transcripts.
  - Recorded formal and operational definitions, environment and task quality
    criteria, an admission checklist, working hypotheses, primary sources, and
    confidence limits.
  - Kept environment, task, harness, rollout, reward, and metrics separate.
    Current platforms draw these package boundaries differently, but the
    distinction prevents runtime behavior from being mistaken for task design.
  - Direct X search returned HTTP 403. The available tool catalog exposes no
    browser or computer-use integration, so this run cannot inherit the user's
    authenticated browser session. Used accessible primary papers, blogs, and
    cross-posts and recorded the X source gap instead of inferring post content.
- Research knowledge system:
  - The single narrative knowledge-base document did not provide atomic source
    provenance, typed semantic links, contradiction tracking, or reliable
    machine validation.
  - Added `knowledge/` with TOML-front-matter source, concept, and synthesis
    notes. Stable IDs decouple semantic links from file locations.
  - Seeded five primary-source notes, five concept notes, one cross-source
    synthesis, a curated research map, and copyable templates.
  - Added `scripts/check_knowledge.py` to reject missing metadata, duplicate
    IDs, malformed relation lists, self-links, and unknown relation targets.
  - Added a user-level `academic-knowledge-curator` subagent that applies the
    schema after literature reviews and records inaccessible evidence instead
    of silently dropping it.
