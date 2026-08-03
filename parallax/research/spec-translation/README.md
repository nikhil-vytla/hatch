# From formal model to platform artifacts: the spec-translation lever

This investigation answers two questions for Parallax. First, what is the
best way to turn the formal task/environment model in
[`docs/MODEL.md`](../../docs/MODEL.md) and the method contracts in
[`docs/methods/`](../../docs/methods/) into concrete, executable task and
environment specifications, the way
[microsoft/evolving-intent](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
and
[SprocketLab/slop-code-bench](https://github.com/SprocketLab/slop-code-bench/tree/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b)
each do in their own idiom? Second, how should those specifications translate
onto HUD, the `verifiers` library, and other RL environment platforms,
repeatably? The deliverable is the smallest tool that makes the translation
deterministic and rerunnable — not a framework.

**Verdict up front.** The second-consumer bar is met for a sealing-aware
spec schema and a cross-platform conformance check, and it is not met for a
general N-platform compiler framework. The recommended lever is three small
pieces: a versioned `TaskSpec`/`EnvSpec` schema lifted from the existing
Pydantic models with the public/sealed boundary as a structural property;
one ordinary deterministic compile function per target platform, each
emitting a digest receipt; and a conformance harness that runs the same
sealed verifier semantics through the reference grader and every compiled
grader and requires identical verdict-and-failure vectors. The schema, the
HUD compiler refactor, and the conformance check should land before paid
SWE screening runs; the `verifiers` target lands after, as the vertical
second-consumer proof.

## 1. What already constitutes a spec in Parallax

`MODEL.md` already defines the abstract objects: a task
\(\tau = (g, c, x_{\mathrm{pub}}, x_{\mathrm{seal}}, V, R)\) with the
authority-separation invariant, and an environment
\(\varepsilon = (\mathcal S, \mathcal O, \mathcal A, P, Z, \mu_0, H, B,
\mathcal U, \kappa)\). It also carries an explicit gate: "Generalize only
after another research journey demonstrates which task and environment
fields need a shared executable representation."

The executable slices have, de facto, already answered part of that
question. Inventorying `src/parallax/`:

| Model | File | Role in the formal model |
| --- | --- | --- |
| `Problem` (branded `SourceAnswer`) | `gsm8k.py` | \(x_{\mathrm{pub}}\) = question; \(x_{\mathrm{seal}}\) = answer; \(V\) = `grade` |
| `Intent`, `Turn`, `Script`, `ScriptFamily` | `evolving_intent.py` | \(\kappa\) (interaction schedule) + matched-arm construction, invariants as model validators |
| `SweBenchProblem` + nested `SweBenchVerifier` | `swebench.py` | public issue fields vs sealed test patch/lists/command/image digest; `public_digest` excludes the verifier |
| `SweScript`, `SweScriptFamily` | `swebench.py` | arm schedules, equal budgets, a substring leak check in `aligned_budget` |
| `Verification` \| `RunFailure` (`Outcome`) | `gsm8k.py`, `runner.py` | verdict vs run-failure discriminated union |
| `ManifestRecord`, `FamilyRecord`, `RunRecord`, `ScreeningPlan` | `runner.py`, `screening.py` | preregistration, identity digests, run evidence |

Two consumers of these shapes exist today: the in-process GSM8K runner
(`runner.py::run_script`, a trivial "platform" but a real consumer of
`Script`/`Problem`), and the HUD SWE environment build
(`swebench_env.py::render_environment`). A third and fourth are on paper:
the proposed checkpoint-evolution method
([`docs/methods/checkpoint-evolution.md`](../../docs/methods/checkpoint-evolution.md))
and any `verifiers` target.

### The observed failure that motivates the lever

The HUD build is where the model's invariants stop being structural.
`render_environment` serializes the **full sealed verifier** — test patch,
FAIL_TO_PASS, PASS_TO_PASS, test command — into `instance.json`, and the
generated Dockerfile does `COPY env.py instance.json /app/` into the same
image whose `/testbed` workspace the agent occupies. With HUD's ssh
capability the agent can read the whole container filesystem, so
\(x_{\mathrm{seal}}\) is agent-reachable during the episode: a direct
violation of the authority-separation invariant, in an arm-comparison
setting where `MODEL.md` says a leaking arm "is not comparable."

The same file hand-rolls grading: `_grade()` returns
`reward = float(result.returncode == 0)` on the whole test command. The
official SWE-bench harness resolves FAIL_TO_PASS and PASS_TO_PASS per test
from parsed logs; returncode-only grading conflates a harness crash, a
PASS_TO_PASS regression, and a genuine failure into one bit. Inside the
environment there is no `Verification`/`RunFailure` separation at all — the
discriminated `Outcome` union exists in `runner.py` but the compiled
artifact never heard of it.

Neither error is a modeling gap. The Pydantic layer knows exactly which
fields are sealed (`SweBenchVerifier` is a separate nested model;
`public_digest` excludes it) and knows the outcome taxonomy. The errors
happen at the **translation boundary**, where a hand-assembled dict
flattens the structure and a hand-written grader re-invents the semantics.
That is precisely the class of error a spec→platform compiler with sealing
rules prevents, and it is the strongest evidence in this investigation.

## 2. How upstream encodes task and environment specs

### microsoft/evolving-intent (pinned `993d6be`)

The spec artifact is the constructed dataset:
`final_dataset/{dataset}_final.json`, produced by the three-stage pipeline
(intent extraction → argument counterfactuals → function predecessors)
described in
[`intent_construction/README.md`](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/intent_construction/README.md),
plus fixed evaluation ID lists in `intent_construction/eval_indices/`. A
sample carries the source function and arguments with counterfactual
variants, a predecessor chain, and the ground-truth `label`.

Execution is a DataLoader-like object
([`situated_simulation/README.md`](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/README.md)):
`EvolvingIntent(data_path, num_turns, num_revisions, num_switches, mode,
seed, ...)` renders conversations **at load time** through a plan-first turn
scheduler; the scenario is inferred from the parameters. The SWE overlay is
a `post_fill_hook` (`turn_scheduler_swe.py`). Each sample serializes its
`ChangePlan` (the paper's \(I_t\)/\(\Delta I_t\) formalization as frozen
dataclasses) into metadata.

The spec/execution boundary is therefore: *intent structure is data;
conversation text is execution*. What they do **not** specify, and what it
costs them:

- **Rendered bytes.** Prefix pools are Python constants
  ([`INTERNALS.md`](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/INTERNALS.md):
  "treat that module as the source of truth rather than copying strings
  here"), so the rendered conversation is not a stable artifact; eval mode
  cycles prefixes deterministically but train mode samples them.
- **Sealing.** `label` sits in the same sample object as the turns; nothing
  structural separates evaluator-only material from agent-visible material.
- **Reproducibility of the published set.** Only ID lists are published,
  not Stage-3 outputs — the reason
  [`DESIGN-SELECTION.md`](../../docs/decisions/DESIGN-SELECTION.md) records
  an unresolved asset question, and `evolving-intent.md` disclaims
  reproduction claims.
- **Failure taxonomy.** None at the artifact level; the scheduler silently
  skips samples whose turn-count math fails.

### SprocketLab/slop-code-bench (pinned `8e3a8b6`)

The spec artifact is a problem folder
([`docs/problems/structure.md`](https://github.com/SprocketLab/slop-code-bench/blob/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b/docs/problems/structure.md)):
`config.yaml` with per-checkpoint `version`/`order`/`state`/
`include_prior_tests` plus `entry_file`, `timeout`, `markers`,
`static_assets`, `test_dependencies`; prose `checkpoint_N.md` specs; and a
pytest tree whose `conftest.py` must expose `--entrypoint`/`--checkpoint`
fixtures. Execution is a `PytestRunner` over Pydantic `EnvironmentSpec`s
discriminated by a `type` field
([`docs/execution/environment_specs.md`](https://github.com/SprocketLab/slop-code-bench/blob/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b/docs/execution/environment_specs.md)),
with agents, models, and runs as separate YAML configs.

Their reward contract is the most instructive part
([`docs/evaluation/architecture.md`](https://github.com/SprocketLab/slop-code-bench/blob/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b/docs/evaluation/architecture.md)):
marker-based test categorization (CORE / FUNCTIONALITY / ERROR /
REGRESSION, with prior-checkpoint tests auto-reclassified to REGRESSION),
and `CorrectnessResults.infrastructure_failure` derived from pytest exit
codes 2–5. That flag is a native RunFailure/Verification separation baked
into the result artifact — the property our compiled HUD grader lost.

What they do **not** specify, and the cost: nothing is sealed (the whole
problem set, tests included, is public in the repo — a contamination
budget they simply accept); the spec-text↔test linkage is a naming
convention; and `include_prior_tests: false` silently changes verifier
semantics (already flagged as a declared-intervention issue in
[`checkpoint-evolution.md`](../../docs/methods/checkpoint-evolution.md)).

**Takeaway.** Each upstream freezes exactly the layer its claims depend on
— evolving-intent freezes intent structure but not text or sealing;
slop-code-bench freezes verifier structure and failure classification but
not secrecy. Parallax's claims depend on sealing, matched arms, and failure
separation, so those are the layers its spec must freeze structurally.

## 3. Platform survey (2026)

### HUD v6 (in-tree pin `hud==0.6.12`)

A [task](https://docs.hud.ai/v6/reference/tasks) is a Pydantic row —
`env` (name, a join key), `id` (template id), `args`, `slug`,
`agent_config`, `runtime_config` (image, resources) — minted by calling an
async-generator template registered with `@env.template` that yields a
prompt, receives the agent's answer, and yields a reward. The
[environment](https://docs.hud.ai/v6/reference/environment) is a wire
protocol handle (manifest, `tasks.start`, `tasks.grade`) plus capabilities
(ssh workspace, MCP tools, CDP, VNC). Grading is environment-side and
returns `EvaluationResult(reward, content, info, subscores)`.

Parallax mapping: matched arms fit naturally as template args (the current
`episode(arm)` template already does this). Sealed authority has **no
structural home**: sealed material lives wherever the env author puts it in
the container, and the ssh capability makes the whole container filesystem
agent-reachable — the observed leak is an instance of a platform-level gap,
not just a local bug. RunFailure separation likewise must be encoded by
convention inside `info`. Both must therefore be enforced by *our*
compiler, not assumed from the platform.

### Prime Intellect `verifiers`

The [library](https://github.com/PrimeIntellect-ai/verifiers) now has two
generations. v0 (`import verifiers as vf`) is the Environment/Rubric/Parser
stack: every env type descends from `MultiTurnEnv` (rollout loop finalized
in the base; subclasses override `env_response()` and `@vf.stop`
conditions); datasets are HF-style rows with `prompt`, `answer`, `info`,
`task` columns; a `Rubric` is a weighted set of reward functions receiving
`prompt/completion/answer/state/parser`. v0 is
[deprecated](https://docs.primeintellect.ai/verifiers/overview); v1
(`verifiers.v1`) splits a **Taskset** (train/eval tasks, prompt shaping,
setup/update/reward hooks, toolsets) from a **Harness** (the program that
drives the model; runtime = subprocess or docker/prime/modal sandbox),
composed by `vf.Env` and distributed via the Environments Hub. New work
should target v1.

Parallax mapping: a `Script` family compiles cleanly — the scripted user is
an `env_response` that replays the next `Turn` (or a v1 taskset update
hook); `answer`/`info` columns are structurally outside the prompt, which
is a mild sealing boundary (though Hub-published datasets are public, so
sealed material must stay in a private taskset). The rubric can be the
*same* grading function the reference implementation uses. RunFailure maps
to `state["error"]`/`has_error` and must be excluded from reward
aggregation at the report layer, preserving the worst-case-bounds
treatment.

### Inspect AI

[Inspect](https://inspect.aisi.org.uk/) (UK AISI) defines a
[Task](https://inspect.aisi.org.uk/tasks.html) as dataset + solver + scorer
(+ sandbox, epochs, setup, approval policy); a sample is
input/target/metadata/files with optional per-sample
[sandbox](https://inspect.aisi.org.uk/sandboxing.html) (Docker, K8s,
Proxmox, ...). The key property for Parallax: **the scorer runs host-side,
outside the sandbox** — `target` and scorer internals never enter the
agent's container unless the author explicitly copies them. That is the
strongest structural sealing story of any surveyed platform, and it is the
architecture the fixed HUD compiler should imitate (sealed material enters
an evaluation context, not the agent image). Inspect also distinguishes
sample errors from scores (`fail_on_error`, retry), mapping well onto
RunFailure separation. METR is migrating its own tooling to Inspect (next
section), which makes it the most likely long-term third target.

### OpenEnv (watch, don't target)

[OpenEnv](https://github.com/meta-pytorch/OpenEnv) (Meta PyTorch + Hugging
Face + a large technical committee) standardizes Gymnasium-style
`step()/reset()/state()` FastAPI servers in Docker, with MCP alongside
(RFCs 002/003) and rewards computed environment-side. It is explicitly
experimental with unstable APIs, and its task-spec shape is env-specific.
Track it; do not compile to it yet.

### SWE-smith / SWE-gym lineage

[SWE-smith](https://arxiv.org/abs/2504.21798) inverts SWE-bench: define one
execution environment per repository, then synthesize task instances inside
it (50k instances, 295 GB of images vs multi-TB per-instance designs). Its
task formulation is deliberately identical to the SWE-bench instance
schema — which is the de-facto SWE interchange format, and which
`SweBenchProblem` already mirrors. No new spec layer to adopt here; the
lesson is that environment identity (image digest) belongs in the spec, as
Parallax already does.

## 4. Prior art: does anyone compile one spec to many platforms?

Three projects triangulate the answer.

- **[METR Task Standard](https://github.com/METR/task-standard)** is the
  closest existing "define a task once, run it via adaptors" standard
  (~200 task families as of 2024). Its trajectory is the cautionary tale:
  METR [deprecated Vivaria and is transitioning to
  Inspect](https://vivaria.metr.org/), and Task Standard tasks now run
  through a one-way
  [bridge](https://github.com/METR/inspect-metr-task-bridge) that by its
  own README "does not adhere completely to the Task Standard." A spec
  standard whose only consumer is its own runtime decays into a bridge.
- **[Harbor](https://www.tbench.ai/news/announcement-2-0)**
  (Terminal-Bench 2.x, [arXiv 2601.11868](https://arxiv.org/abs/2601.11868))
  runs 20+ benchmarks through per-benchmark **adapters** into one harness
  with RL rollout interfaces. That is many-specs→one-platform — the inverse
  direction of Parallax's need, and evidence that the ecosystem norm is
  hand-ported adapters, not shared specs.
- **[CUBE](https://arxiv.org/abs/2603.15798)** (AI Alliance,
  [alpha](https://github.com/The-AI-Alliance/cube-standard)) is the first
  genuine wrap-once-run-anywhere attempt, but it standardizes the **runtime
  protocol** (MCP + Gym-style task/benchmark APIs), not the experiment
  spec: it has no sealing semantics, no matched arms, no preregistration.
  If it matures it becomes one more compile *target*, not a substitute for
  the spec layer.

So: no existing standard expresses what Parallax must express — sealed
authority as a schema property, matched-arm families, and
RunFailure-separated verdicts. Nothing to adopt wholesale; nothing being
reinvented by building a Parallax-internal schema. Equally, the METR lesson
argues *against* designing the schema as a would-be community standard:
build it for Parallax's two consumers and keep it private to the harness.

## 5. Is the second-consumer bar met?

Honest answer: **yes for the schema and the conformance check; no for a
compiler framework.**

For the sealing schema and conformance harness, the bar is met on three
grounds. First, two consumers of the same spec shapes already exist in the
tree — the in-process GSM8K runner and the HUD SWE build — and they have
already diverged in exactly the way the earlier arena feared: the runner
preserves `Verification | RunFailure`, the compiled environment does not.
Second, the failure is observed, not hypothetical: sealed bytes in the
agent image and returncode-only grading are in `swebench_env.py` on `main`
today. Third, `MODEL.md`'s own TODO gate — generalize only after another
journey demonstrates *which fields* need a shared executable representation
— has been satisfied by the SWE journey: the fields are the public/sealed
split and the verdict contract, and (importantly) **only** those. Nothing
observed demands executable representations of \(P\), \(Z\), or
\(\mathcal S\); the environment spec should stay at image identity,
workspace, tools, budgets, and schedule.

For a general framework — plugin registries, N platforms, a transformation
DSL — the bar is not met. There is exactly one real remote backend in
progress. The `verifiers` target has no experiment demanding it yet; it
earns its existence as the vertical proof (§7), not before.

## 6. The lever

Three pieces, in dependency order. Total new surface is one schema module,
one compile function per platform, and one test harness — no new packages,
no runtime services.

### (i) `TaskSpec`/`EnvSpec` v1: sealing as a structural property

Derive, do not invent: the schema is a re-arrangement of models that
already exist (`SweBenchProblem`, `SweBenchVerifier`, `Script*`,
`Problem`, `Outcome`), versioned with the same `schema_version` discipline
as `ManifestRecord`. The one structural change is the split at the top:

```python
class TaskSpecV1(StrictModel):
    schema_version: Literal[1] = 1
    public: PublicTaskV1        # g, c, x_pub: statement, repo, base_commit,
                                # arm scripts, budgets, schedule
    sealed: SealedAuthorityV1   # V, R, x_seal: test patch, test lists,
                                # test command, expected answer, normalization
    # digests: public_digest over `public` only, spec_digest over both

class EnvSpecV1(StrictModel):
    schema_version: Literal[1] = 1
    image: ImageIdentity        # ref + digest (already pinned today)
    workspace: WorkspacePolicy  # root, network, reset semantics
    tools: tuple[ToolDecl, ...] # U: director MCP, shell, ...
    budget: BudgetDecl          # H, B: steps, tokens, timeouts
```

Sealing becomes structural through the compiler contract, not a review
convention: every emitted artifact carries an `audience: "agent" |
"evaluator"` tag, and the function that renders agent-audience artifacts
takes `PublicTaskV1` as its argument type — it cannot mention sealed fields
without a type error. The current bug is impossible to re-introduce
silently because `render_environment(family)` (which received everything)
no longer exists; its replacement is two functions with different input
types. The existing substring leak check in `SweScript.aligned_budget`
generalizes into invariant 1 below.

Checkpoint evolution's two extensions (family-valued output, monotone
sealed accumulation) fit without schema surgery: a family is a tuple of
`TaskSpecV1` plus a declared coupling, and accumulation is a validator over
consecutive `sealed` fields — both already sketched in the method doc.

### (ii) One compile function per platform, with a receipt

Per target platform, one ordinary function (explicit import, per ADR-001's
rejection of registries and discovery):

```
compile_hud(task: TaskSpecV1, env: EnvSpecV1) -> CompiledBundleV1
compile_verifiers(task: TaskSpecV1, env: EnvSpecV1) -> CompiledBundleV1   # second
```

A `CompiledBundleV1` is a tuple of `(path, audience, bytes)` artifacts plus
a **receipt**: spec digests in, compiler version, SHA-256 per artifact out.
Determinism is the house style already (canonical JSON, sorted keys, atomic
writes): same spec bytes in, same artifact bytes out, byte-stable golden
files in CI. For HUD, the compiled bundle changes placement, imitating
Inspect's host-side scorer: the agent image gets only agent-audience
artifacts (public `instance_public.json`, turn scripts); sealed material
travels in an evaluator-audience artifact applied at grade time in a fresh
verifier context (the official SWE-bench harness's own pattern — evaluate
in a fresh container from the pinned image), never in the agent image
build context.

Invariants checked at compile time, all of which fail the build:

1. **No sealed bytes in agent artifacts.** Byte-level scan of every
   agent-audience artifact (and the Dockerfile build context) for every
   sealed field value — the belt to the type system's suspenders.
2. **Verdict contract.** The emitted grader must be generated *from* the
   sealed spec (per-test FAIL_TO_PASS/PASS_TO_PASS resolution, not
   returncode), and must emit the `Verification | RunFailure` union with
   `failure_kind` for harness/container faults — mirroring
   slop-code-bench's `infrastructure_failure` flag, which their artifacts
   prove is representable in a test-runner result.
3. **Arm parity.** Re-validate the `ScriptFamily` invariants over compiled
   artifacts: all arms share `spec_digest` of the source and sealed
   authority; agent artifacts across arms differ only in declared
   intervention fields; budgets equal.

### (iii) The conformance check (the piece that would have caught both bugs)

A test harness, not a service: for each compiled target, run a fixed set of
**fixture submissions** through both the reference in-process grader and
the compiled platform grader, and require identical
`(verdict, failure_kind)` vectors.

- Inputs: a frozen `TaskSpecV1` fixture (for SWE, a miniature git repo with
  one trivial FAIL_TO_PASS test — no official image pull needed for the
  unit tier) and fixture submissions: known-good patch, known-bad patch,
  patch touching sealed test files, and a simulated harness crash.
- Outputs: a conformance record — spec digest, target, per-fixture
  `(expected, actual)` outcome pairs — retained as run evidence.
- The golden test: CI recompiles the frozen fixture spec, asserts artifact
  digests match the receipt (determinism), asserts the sealed-byte scan
  passes (would have caught `instance.json` in the agent image), and
  asserts the conformance vector matches (the harness-crash fixture returns
  `RunFailure(failure_kind="verifier")`, not reward 0.0 — would have caught
  returncode-only grading; the sealed-test-file fixture returns the same
  verdict both sides — pins the restore-then-apply semantics).

### What NOT to build

- **No plugin registry, no domain enum, no discovery scan.** Compile
  functions are explicitly imported, one per platform, exactly as ADR-001
  requires for domain adapters.
- **No DSL and no transformation algebra.** The spec is frozen data;
  synthesis strategies keep their own state machines and emit specs, per
  ADR-001's rejection of a universal algebra. The compiler never generates
  content at build time (no runtime generation inside deterministic
  builds).
- **No community interchange standard.** CUBE already occupies the protocol
  layer, and the METR Task Standard shows what happens to spec standards
  without live second consumers. This schema is Parallax-internal.
- **No third compiler until a real experiment demands one.** Inspect is the
  most likely candidate; it waits for a consumer.

This differs from the arena's Alternative C rejection in kind, not just
degree. What
[`DESIGN-SELECTION.md`](../../docs/decisions/DESIGN-SELECTION.md) and
[`ADR-001`](../../docs/decisions/ADR-001.md) rejected was a closed-enum
domain compiler with seam-authored provenance and a universal
transformation algebra, proposed when there was one method, no real
backend, and no observed failure. Today there are two methods (one
implemented, one specified), a real backend in progress, a second in-tree
consumer, and a concrete observed failure of exactly the class the lever
prevents — and the proposal is narrower than what was rejected: a schema
plus two ordinary functions plus a test, with the strategy and domain
boundaries of ADR-001 left untouched.

## 7. Sequencing

**The schema, the HUD compiler refactor, and the conformance check land
before the screening path is declared stable — because the screening path
is not stable without them.** Screening evidence graded returncode-only is
not interpretable: a PASS_TO_PASS regression, a harness crash, and a real
failure all read as the same zero, which breaks the
`Verification`/`RunFailure` separation that `screening.py`'s
`summarize_screening` and the worst-case bounds depend on. And any
screening episode run with sealed material in the agent image is
inadmissible under the authority-separation invariant anyway. Fixing
`swebench_env.py` *is* the first compiler; doing it as a spec-driven build
with the conformance harness costs one refactor rather than a parallel
system. Order of work:

1. Extract `TaskSpecV1`/`EnvSpecV1` from the existing models (type
   re-arrangement; no behavior change; `parallax/src` untouched by this
   research folder — this is the next implementation slice).
2. Rewrite the HUD build as `compile_hud` with audience-tagged artifacts,
   evaluator-side sealed delivery, a per-test grader, and the receipt.
3. Land the conformance harness with the miniature SWE fixture; wire the
   golden test into CI. Only then run paid screening.

**First vertical proof** (in order): the SWE conformance fixture catching
the two known bugs against the pre-refactor renderer — the lever validated
against ground truth, cheap and offline. **Second proof, and the true
second-consumer test:** compile the existing GSM8K experiment spec to a
`verifiers` env — dataset rows from `Problem`/`Script` public fields, the
scripted user as `env_response` replaying turns, the rubric calling the
same `grade` function — run the deterministic scripted agent from the
existing offline tests through it, and require the paired report to match
the in-process runner's report record-for-record (modulo transport
fields). That proof is offline, free, and parallelizable with screening; if
it fails, the schema was wrong and the failure is cheap to observe before a
third consumer exists.

## Sources

Upstream repositories (pinned): [microsoft/evolving-intent
`993d6be`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
(README, `intent_construction/README.md`, `situated_simulation/README.md`,
`situated_simulation/INTERNALS.md`); [SprocketLab/slop-code-bench
`8e3a8b6`](https://github.com/SprocketLab/slop-code-bench/tree/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b)
(`docs/problems/structure.md`, `docs/evaluation/architecture.md`,
`docs/execution/environment_specs.md`, `examples/calculator`). Papers:
[LLMs Get Lost in Evolving User Intent (arXiv
2607.20734)](https://arxiv.org/abs/2607.20734);
[SlopCodeBench (arXiv 2603.24755)](https://arxiv.org/abs/2603.24755);
[SWE-smith (arXiv 2504.21798)](https://arxiv.org/abs/2504.21798);
[Terminal-Bench (arXiv 2601.11868)](https://arxiv.org/abs/2601.11868);
[CUBE (arXiv 2603.15798)](https://arxiv.org/abs/2603.15798). Platforms:
[HUD v6 tasks](https://docs.hud.ai/v6/reference/tasks) /
[environment](https://docs.hud.ai/v6/reference/environment) /
[hud-python](https://github.com/hud-evals/hud-python);
[verifiers](https://github.com/PrimeIntellect-ai/verifiers) and
[docs](https://docs.primeintellect.ai/verifiers/overview);
[Inspect AI](https://inspect.aisi.org.uk/)
([tasks](https://inspect.aisi.org.uk/tasks.html),
[sandboxing](https://inspect.aisi.org.uk/sandboxing.html));
[OpenEnv](https://github.com/meta-pytorch/OpenEnv). Prior art:
[METR Task Standard](https://github.com/METR/task-standard),
[Vivaria transition notice](https://vivaria.metr.org/),
[inspect-metr-task-bridge](https://github.com/METR/inspect-metr-task-bridge);
[Harbor / Terminal-Bench 2.0](https://www.tbench.ai/news/announcement-2-0),
[CUBE standard repo](https://github.com/The-AI-Alliance/cube-standard).
In-tree: [`docs/MODEL.md`](../../docs/MODEL.md),
[`docs/decisions/ADR-001.md`](../../docs/decisions/ADR-001.md),
[`docs/decisions/DESIGN-SELECTION.md`](../../docs/decisions/DESIGN-SELECTION.md),
[`docs/methods/evolving-intent.md`](../../docs/methods/evolving-intent.md),
[`docs/methods/checkpoint-evolution.md`](../../docs/methods/checkpoint-evolution.md),
and `src/parallax/` (`types.py`, `gsm8k.py`, `evolving_intent.py`,
`runner.py`, `swebench.py`, `swebench_env.py`, `screening.py`).
