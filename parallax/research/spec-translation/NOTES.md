# Working notes — spec translation research

## 2026-08-02

### Context absorbed (in-tree)

- `docs/MODEL.md` defines TaskSpec τ = (g, c, x_pub, x_seal, V, R) and
  EnvironmentSpec ε = (S, O, A, P, Z, μ0, H, B, U, κ). The sealing boundary is
  already formal in the model: x_pub vs x_seal, with the authority-separation
  invariant. MODEL.md carries an explicit TODO: "Generalize only after another
  research journey demonstrates which task and environment fields need a
  shared executable representation."
- `docs/decisions/DESIGN-SELECTION.md` + `ADR-001.md`: the arena rejected
  Candidate C (closed domain enum, seam-authored traces) and a universal
  transformation algebra. ADR-001 explicitly rejects global registries,
  runtime generation inside deterministic builds, and generic escape hatches.
  Note: the earlier rejection was about a *universal strategy algebra* and a
  *closed-enum domain compiler*, judged premature with one method and no runs.
- De-facto specs already in src/parallax (all frozen strict Pydantic):
  - GSM8K: `Problem` (record_id, question, sealed branded `SourceAnswer`),
    `Intent/Turn/Script/ScriptFamily` (three matched arms + budgets as model
    validators), `ManifestRecord/FamilyRecord/RunRecord` evidence union.
  - SWE: `SweBenchProblem` (public fields) + nested `SweBenchVerifier`
    (sealed: test_patch, fail_to_pass, pass_to_pass, test_command, image
    digest, harness revision). `public_digest` = digest excluding verifier.
    `SweScript.aligned_budget` validator already does a *substring* leak check
    of sealed material against turn text.
  - `screening.py`: preregistered `ScreeningPlan` with design digest;
    Verification | RunFailure outcome discriminated union.
- **Confirmed pain (the leak)**: `swebench_env.py::render_environment` writes
  the FULL verifier (sealed test_patch + test lists) into `instance.json`,
  and `Dockerfile.hud` does `COPY env.py instance.json /app/` into the SAME
  image where the agent works (`/testbed`, same filesystem). Nothing
  structural prevented it: the sealed/public split exists in the Pydantic
  models but serialization flattens it — sealing is a convention at the
  serialization boundary, not a property of it.
- **Confirmed pain (grading)**: `_grade()` in the generated env.py decides
  pass/fail by `result.returncode == 0` on the whole test command. No
  per-test FAIL_TO_PASS/PASS_TO_PASS resolution (official harness parses
  logs per test), no RunFailure-vs-Verification separation inside the env
  (a harness crash and a failing test are both reward 0.0).

### Key observation for second-consumer question

Consumers of a "task spec → platform artifact" translation that exist today:
1. HUD SWE env build (`render_environment`) — implemented, has the leak.
2. GSM8K local runner (`run_script`) — implemented; the "platform" is a
   trivial in-process loop, but it consumes the same Script/Problem shapes.
Proposed: checkpoint-evolution families (docs/methods/checkpoint-evolution.md)
and a verifiers-library target. So: one real compiler exists (buggy), a second
in-process consumer exists, a third+fourth are on paper. Honest read: the bar
is *met for the sealing schema + conformance check*, arguably *not yet met*
for a multi-platform compiler framework — hence build the smallest lever.

### Research plan

1. Upstream encodings: microsoft/evolving-intent JSON + scheduler config;
   slop-code-bench problem folders.
2. Platforms: HUD v6, verifiers (Prime Intellect), Inspect AI, OpenEnv,
   SWE-smith/SWE-gym lineage.
3. Prior art: one-spec-to-many-platforms compilers / interchange formats.
4. Design the lever; sequencing.

### Upstream encodings (repo inspection, pinned commits)

**microsoft/evolving-intent @ 993d6be** (via GitHub API tree + README/INTERNALS):
- Spec artifact = `final_dataset/{dataset}_final.json` (Stage 1 extraction →
  Stage 2 argument counterfactuals → Stage 3 predecessors) plus
  `intent_construction/eval_indices/*.json` ID lists. Sample carries
  `task_id`, source function/arguments with counterfactual variants,
  predecessor chain, `label` (ground truth), passthrough metadata.
- Execution = `situated_simulation/user_simulation.py::EvolvingIntent`, a
  DataLoader-like object; the plan-first `turn_scheduler.py` renders turns AT
  LOAD TIME from runtime params (`num_turns`, `num_revisions`,
  `num_switches`, `mode`, `seed`) and from prefix pools that live as Python
  constants ("treat that module as the source of truth rather than copying
  strings here"). SWE overlay = `post_fill_hook` in `turn_scheduler_swe.py`.
  `ChangePlan` (frozen dataclasses in `user_intent.py`) serialized into
  `metadata["change_plan"]` per sample.
- Boundary: constructed *intent structure* is data; *rendered conversation*
  is execution. NOT specified: rendered bytes (regenerated each run, prefix
  pools are code), sealed/public separation (label sits inside the same
  sample dict as turns), budgets, failure taxonomy. Costs they pay: published
  artifact is ID lists only → no independent reproduction of Stage-3 pools
  (matches DESIGN-SELECTION's open-ambiguity note); scheduler silently skips
  samples when `t < 1 + g + p`; eval vs train prefix selection differs.

**SprocketLab/slop-code-bench @ 8e3a8b6**:
- Spec artifact = problem folder: `config.yaml` (versioned per checkpoint:
  `version`, `order`, `state`, `include_prior_tests`, `entry_file`,
  `timeout`, `markers`, `static_assets`, `test_dependencies`),
  `checkpoint_N.md` prose specs, `tests/` pytest tree with REQUIRED
  `--entrypoint`/`--checkpoint` conftest fixtures, `tests/data/` case dirs.
- Execution = `PytestRunner` (copy tests → pytest.ini → uvx isolated run →
  CTRF + pytest-json-report parse → GroupType categorization) over
  `EnvironmentSpec` (Pydantic, `type` discriminator picks runtime backend;
  docker/local). Agents/models/runs are separate YAML configs.
- Reward contract: marker-based GroupType (CORE/FUNCTIONALITY/ERROR/
  REGRESSION; prior-checkpoint tests auto-reclassify to REGRESSION), and —
  notable — `CorrectnessResults.infrastructure_failure` derived from pytest
  exit codes 2–5. That is a native RunFailure/Verification separation at the
  artifact level. `include_prior_tests: false` is a silent verifier change
  (checkpoint-evolution.md already flags it).
- NOT specified/sealed: everything is public in the repo (contamination);
  spec-text↔test linkage is naming convention only; env spec is per-run
  config, not part of problem identity.

### Platform survey (2026)

**HUD v6** (docs.hud.ai/v6; in-tree pin `hud==0.6.12`):
- Task = Pydantic row: `env` (name, join key), `id` (template id), `args`,
  `slug`, `agent_config`, `runtime_config` (image, resources). Authored as
  async-generator `@env.template` with exactly two yields (prompt → reward).
- Env = `Environment` object served over wire protocol (manifest,
  `tasks.start`, `tasks.grade`); capabilities: ssh (workspace shell), mcp,
  cdp, rfb. Grading env-side; `EvaluationResult(reward, content, info,
  subscores)`.
- Sealing: NO structural boundary — sealed material lives wherever the env
  author puts it in the container; with the ssh capability the agent can
  reach the whole container filesystem. Exactly the failure mode we hit.
- RunFailure: no verdict/failure discrimination in EvaluationResult; must be
  encoded in `info` by convention.
- Matched arms: template args (our `episode(arm)`) — fits.

**Prime Intellect verifiers** (github.com/PrimeIntellect-ai/verifiers;
docs.primeintellect.ai/verifiers):
- v0 (`import verifiers as vf`): Environment/Rubric/Parser; all env types
  descend from `MultiTurnEnv` (rollout loop finalized; `env_response()` +
  `@vf.stop`). Dataset rows: `prompt`, `answer`, `info`, `task`. Rubric =
  weighted (a)sync reward funcs receiving `prompt/completion/answer/state/
  parser`. v0 is DEPRECATED.
- v1 (`verifiers.v1`): Taskset (train/eval tasks, prompt shaping,
  setup/update/reward hooks, toolsets) + Harness (program, endpoint proxy,
  sandbox runtime: subprocess/docker/prime/modal) composed by `vf.Env`.
  Environments Hub distribution; prime-rl training integration.
- Sealing: `answer`/`info` columns are structurally outside the prompt, but
  datasets are typically public on the Hub; state dict free-form. Scripted
  multi-turn user = `env_response` replaying our Script turns.
- RunFailure: `state["error"]` + `has_error` stop condition; must keep
  failures out of reward aggregation at report level.

**Inspect AI** (inspect.aisi.org.uk): Task = dataset + solver + scorer (+
sandbox, epochs, setup, approval). Sample = input/target/metadata/files/
sandbox. KEY property: scorer runs host-side; `target` never enters the
sandbox unless the author puts it there — the strongest structural sealing
story of the surveyed platforms. Per-sample sandboxes (Docker/K8s/Proxmox).
Sample-level error handling distinguishes errors from scores (`fail_on_error`,
retry). METR is migrating to Inspect (see below).

**OpenEnv** (meta-pytorch/OpenEnv; RFC 002): Gymnasium-style step/reset/state
FastAPI servers in Docker; MCP interface alongside (RFC 003); rewards
computed env-side ("encapsulation"). Experimental; APIs unstable; task spec
shape is env-specific. Big technical committee (Meta, HF, Prime Intellect,
NVIDIA, Modal...). Watch, don't target yet.

**SWE-smith / SWE-gym lineage** (arXiv 2504.21798): env-first construction
(one image per repo, tasks synthesized inside), task formulation identical
to SWE-bench instance schema — the de-facto SWE interchange format, which
`SweBenchProblem` already mirrors. 50k instances / 295 GB vs SWE-bench's
per-instance images.

### Prior art: one spec → many platforms?

- **METR Task Standard** (github.com/METR/task-standard): the closest thing
  to a "write task once, run via adaptors" standard (~200 families / ~2000
  tasks). Outcome: METR deprecated Vivaria, is transitioning to Inspect, and
  Task Standard tasks now run through a one-way bridge
  (METR/inspect-metr-task-bridge) that "does not adhere completely to the
  Task Standard". Lesson: a spec standard without a live second consumer
  decays into a bridge.
- **Harbor / Terminal-Bench 2.x** (tbench.ai, arXiv 2601.11868): one harness,
  20+ benchmark ADAPTERS (SWE-bench, SWE-smith, Aider Polyglot...). Direction
  is many-specs→one-platform — the inverse of our need. Harbor task format =
  task.toml + instruction.md + env/test scripts; RL rollout interfaces.
- **CUBE** (arXiv 2603.15798, AI Alliance, alpha): protocol standard (MCP +
  Gym-style) to wrap a benchmark once and use it on any compliant platform.
  Standardizes the RUNTIME INTERFACE, not the experiment spec: no sealing
  semantics, no matched arms, no preregistration. Candidate future compile
  target, not a substitute for the spec layer.
- Nobody found compiles one *experiment* spec (sealed authority + matched
  arms + failure separation) to multiple platforms. Benchmark ports (e.g.
  prime-environments, Inspect evals) are hand-ports per platform.

### Design conclusions (drafted in README)

- Second-consumer bar: MET for the sealing schema + conformance harness
  (HUD SWE path and the in-process GSM8K runner are two live consumers of
  the same spec shapes today, and the observed leak is the exact error class
  the lever prevents). NOT met for a general N-platform compiler framework —
  build the verifiers compiler only as the vertical proof, nothing beyond.
- The lever = (i) TaskSpec/EnvSpec v1 frozen Pydantic schema where
  public/sealed is structural (agent artifacts constructible only from the
  public branch; audience tag on every emitted artifact), (ii) one ordinary
  deterministic compile function per platform with a digest receipt,
  (iii) a conformance harness running fixture submissions through the
  reference grader and each compiled grader, requiring identical
  (verdict | failure_kind) vectors + a sealed-byte scan of agent-reachable
  build contexts.
- Sequencing: schema + HUD compiler refactor + conformance check land BEFORE
  paid screening (returncode-only grading would corrupt screening evidence);
  GSM8K→verifiers proof lands after/parallel as the second-consumer proof.

## 2026-08-02 implementation

PR #20 implements the first target from this design. `TaskSpecV1` and
`EnvSpecV1` rearrange the existing SWE models into a structural public and
sealed split. `compile_hud` emits audience-tagged artifacts and a digest
receipt. Its agent renderer accepts only `PublicTaskV1`. The evaluator reloads
a separate compiled artifact before official grading. The retained conformance
tests reject both historical bug doubles and pass all four fixture submissions
on the current compiler.

