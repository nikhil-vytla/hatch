# Episode spine working notes

## 2026-07-31

- Re-grounded the design in HUD v6. `Chat.send()` creates one fresh rollout
  per user turn. It cannot reproduce Evolving Intent's persistent SWE workspace.
- Confirmed the Microsoft SWE runner keeps one mini-swe-agent container and
  conversation alive, intercepts `Submitted`, injects the next user intent,
  and resumes. Per-turn budget exhaustion may also advance; global cost
  exhaustion terminates the episode.
- Ran four independent architecture sketches and a cross-judge. The selected
  base is a single content-addressed episode specification with one admission
  and reward authority.
- Selected grafts:
  - failures count as evaluator faults only if they reproduce on the untouched
    starter state;
  - runtime modules cannot import sealed types;
  - HUD API drift gets a pinned canary test;
  - adapter compilation is hermetic and exporters report lossy fields;
  - staged and persistent write policies are coupled to verifier policy.
- Rejected `Chat`, one HUD task per turn, Prime's per-model-turn user simulator,
  post-hoc zero-reward grading, and skill-generated reward code for stateful
  coding episodes.
- Corrected a proposed HUD design: capabilities added from a running task
  template are absent from the already-negotiated agent manifest. The intent
  director must be registered during environment initialization and hold
  per-episode state populated when the task starts.
- Two implementation spikes must precede the full build:
  1. prove a pre-registered director capability can reveal task-specific turns
     without placing future turns in the agent prompt or workspace;
  2. prove mini-swe-agent's synchronous environment interface can execute over
     HUD's asynchronous SSH client safely under concurrent rollouts.
- Implemented both spikes under `spikes/`:
  - a FastMCP director registered in `@env.initialize` accepted task-scoped
    state populated by the template and revealed turns only when the custom
    agent called `advance`;
  - a synchronous mini-swe-shaped environment ran on a worker thread and used
    `asyncio.run_coroutine_threadsafe` to execute through HUD's SSH client;
  - two bridge calls ran concurrently, and mini-swe-agent 2.4.6
    `DefaultAgent.step()` executed a real action through the bridge.
- Verification command:
  `HUD_TELEMETRY_ENABLED=false uv run --project hud_env --with pytest
  --with mini-swe-agent --with-editable . pytest -q
  architecture/episode-spine/spikes/test_hud_spikes.py`
  passed in 1.49 seconds.
- HUD telemetry must be disabled for local contract tests. With telemetry
  enabled and no usable backend, the same passing test spent roughly three
  minutes waiting during trace export.
- The local spike resolves API feasibility. Docker concurrency and a deployed
  HUD runtime still need explicit verification before calibration.
- Episode Spine migration unit red test:
  `PYTHONPATH=src uv run pytest -q tests/test_episode_spine.py
  --basetemp=.test-tmp` failed 12 tests before implementation.
- The failures reproduced the four reward-authority defects directly:
  import-time `os._exit(0)` scored 1, a committed forbidden edit scored 1,
  deleting `.git` raised `ValueError`, and a rewritten probe anchor raised
  `EditError`.
- The same red run showed that `Check` accepted zero, negative, NaN, and
  infinite weights, `Recipe` accepted no counterfactual primary, ignored paths
  were not policy data, and `Check` had no success-marker field.

## 2026-08-01

- Completed the first Episode Spine migration unit:
  - canonical JSON identity now commits `TaskManifest.task_id` to separate
    public and sealed digests;
  - immutable `TreeSnapshot` baselines replace agent-controlled Git status;
  - grading returns `SCORED`, `INVALID_SUBMISSION`, or `ABSTAIN`;
  - a counterfactual check is the primary objective, while regression and
    adversarial checks are hard gates;
  - verifier checks run with an allowlisted environment and must emit a
    content-derived success marker.
- The 12 adversarial tests that initially failed are green. The complete local
  suite passed: 47 tests in 1.55 seconds. Ruff also passed.
- Re-ran admission for all 12 Click recipes against pinned Click revision
  `00e592cea702e0b2caa0dee42489fdb1c22cd845`. Every oracle passed
  deterministically, while no-op, forbidden-path, and upstream-restore
  submissions all received zero reward. Evidence is in `admission-v2.json`.
- Kept the recipe generator executable as a standalone Python script; importing
  the package there made regeneration depend on an installed editable package.
- Completed the remaining proof sequence: persistent Docker episode, official
  SWE-bench instance, then `hud deploy`.
- Implemented a deployable `parallax_episode_spine` HUD environment with a
  pre-registered director and one persistent workspace.
- Its Docker contract passed three hidden turns through one HUD run and one
  mini-swe-agent instance. The accumulated file state was
  `seed`, `alpha`, `beta`, `gamma`, and the terminal reward was 1.
- Ran the pinned official SWE-bench harness at
  `f7bbbb2ccdf479001d6467c9e34af59e44a840f9` against the gold patch for
  `django__django-11099`. It resolved with 3/3 fail-to-pass and 19/19
  pass-to-pass tests. Evidence is in `swebench-proof.json`.
- The harness wheel omitted a Rust fixture, so the proof ran from the same
  pinned official source checkout. The documentation's suggested
  `sympy__sympy-20590` canary is currently broken because upstream deleted the
  `1.7` branch its setup script clones; Django was used without modifying the
  harness.
- The initial post-deploy 404 was not API drift. `hud deploy` normalized
  declared name `parallax_episode_spine` to registry key
  `parallax-episode-spine`, while `HUDRuntime` sent `Task.env` verbatim.
- A normalized-name diagnostic created the session but received 409 at the
  WebSocket because local telemetry had been disabled. The tunnel authorizes
  against a platform-visible rollout trace.
- Renamed the environment to its canonical registry key and kept telemetry
  enabled for hosted runs. `hud deploy` published version 2; remote
  introspection found one task and three capabilities, and the unmodified
  hosted canary passed with reward 1 in 43.84 seconds.
- The deployment receipt is in `deployment.json`.

## 2026-08-01 SWE-bench episode and calibration

- Added a content-addressed SWE-bench source/verifier adapter and compiled
  static, matched-no-change, and evolved schedules that share source and
  verifier commitments while retaining distinct episode identities.
- Built a local HUD environment for `django__django-11099` from the official
  pinned test environment. One mini-swe-agent conversation and one workspace
  persist across all director turns. The sealed grader restores the official
  test file, applies the official test patch, and runs the same focused Django
  test command used by the pinned SWE-bench harness.
- Contract checks passed: the gold semantic edit received reward 1 in all three
  arms and a no-op received 0.
- The first GPT-5.6 Sol calibration exposed a reward-policy defect: the model
  made the source fix and added focused regression tests in every arm, but the
  scope gate rejected the test file. Agent-written tests cannot influence the
  sealed score because grading restores that file before applying the official
  patch, so the policy now permits that focused test path.
- After correction, GPT-5.6 Sol scored 1 on static, matched, and evolved arms.
  Qwen3 8B scored 0 on all three without changing the workspace. Across six
  runs the mean reward is 0.5. The initial interpretation that this
  discriminated the sampled model capabilities is superseded: the Qwen rows
  were invalid submissions with no tracked changes, not valid failed patches.
- With GPT-5.6 Sol at ceiling and one run per arm, the smoke test is
  inconclusive. It shows no observed matched-to-evolved difference but does
  not establish a measured null or a capability difference. The next
  calibration needs harder instances, models near the decision boundary,
  repeated runs, and valid submissions.
- The local Dockerfile currently inherits the official harness's cached
  `sweb.env` image. That image is not public in the Docker registry, so the
  benchmark environment is not yet remotely reproducible by `hud deploy`.
