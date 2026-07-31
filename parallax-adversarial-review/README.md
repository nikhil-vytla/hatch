# Adversarial review: Parallax variant layer vs autoresearch intent

**Verdict:** The current `parallax.variants` work is a typed **contract catalog** with a structural admission checker. It does **not** yet implement a reproducible autoresearch loop. The first valid Evolving Intent prototype is blocked by missing execution, budget wiring, harness/model outcome classification, and a dual task model (`Recipe` vs `TaskSpec`) that never joins. Ten variant families before one paired executable study is premature complexity.

Tests for the modeling layer pass (`tests/test_variants.py`: 7). That validates schemas and local invariants, not the research objective.

---

## Findings

### F1 — Critical — No executable loop from source task → variant → rollout → finding

| | |
| --- | --- |
| **Location** | `src/parallax/variants.py`, `scripts/plan_variants.py`, `hud_env/env.py`, package layout |
| **Evidence** | `TaskSpec` / `TaskVariant` appear only in `variants.py`, `plan_variants.py`, and `test_variants.py`. `parallax.__init__` exports Recipe/compiler/grade only. `plan_variants.py` writes blueprint JSON (`family`, `components`, `verifier_policy`, …) and explicitly warns candidates still need admission. `hud_env/env.py` `repair` yields a single prompt, then grades via `Recipe` name lookup. No code materializes trajectories into multi-turn agent messages, freezes a harness fingerprint, sweeps one intervention, or feeds `decide_curriculum` from machine-written run records. README Limitations lines 322–324 state the same gap. |
| **Suggestion** | Do not expand the enum/catalog further. Add a thin **RunRecord** + **execute_variant** path: static baseline Recipe (or one fixture task) ↔ one hand-authored `AnchorTrajectory` ↔ multi-turn HUD template ↔ existing `grade_candidate` ↔ JSONL results. Wire `plan_variants` later, or replace it with `emit_ei_pair(source) -> {baseline, evolving}`. |

### F2 — Critical — Dual task abstractions never join (`Recipe` vs `TaskSpec`)

| | |
| --- | --- |
| **Location** | `src/parallax/models.py` (`Recipe`, `TaskManifest`) vs `src/parallax/variants.py` (`TaskSpec`, `TaskVariant`) |
| **Evidence** | Executable truth today is `Recipe`: pinned source, text edits, probes, weighted checks, `allowed_paths`. Variant truth is `TaskSpec`: opaque `initial_state_id`, `verifier_id`, string goals/constraints, `Budget`. There is no adapter `Recipe -> TaskSpec`, no `verifier_id` resolver to `recipe.checks`, no way for `admit_variant` to invoke `scripts/admit.py` gold/no-op/mutant matrix. Every future generator will invent a third serialization unless this is collapsed. |
| **Suggestion** | Code judo: make `TaskSpec` a **view** over a versioned compiled task (manifest digest + sealed verifier digest + budget + prompt), or embed variant provenance fields on `TaskManifest`. Keep one executable identity. Treat `verifier_id` as content-addressed hash of sealed checks, not a free string. |

### F3 — Critical — Evolving Intent has compile-time replay, not runtime staging

| | |
| --- | --- |
| **Location** | `variants.py` `compile_anchor_trajectory` / `admit_variant`; `hud_env/env.py` `repair`; `adapters.py` `agent_config` |
| **Evidence** | Trajectory compiler correctly enforces terminal return to anchor (tests cover restore and stale-terminal reject). Admission for staged EI only checks that compile succeeds and declared deltas match instruction+budget. Runtime still sends one static `prompt`. `StateMode.STAGED` / `READ_ONLY` are never enforced (writes always available after first message). Microsoft Evolving Intent and local knowledge (`anchored-intent-trajectory.md`, `controlled-task-variation.md`) require read-only or staged precursors when reusing the source verifier; persistent edits need a different verifier. None of that exists in `hud_env`. |
| **Suggestion** | Add `repair_evolving` (or parameterize `repair`) that: (1) yields turn messages from `CompiledTrajectory.turns` on a frozen schedule; (2) disables mutating tools until the terminal `SWITCH` (or until last turn); (3) grades once with the **same** sealed recipe as the static twin. Hand-author one trajectory for the prototype; defer LLM turn generation. |

### F4 — Critical — Harness vs model failures are documented manually, not classified in code

| | |
| --- | --- |
| **Location** | `src/parallax/calibration.py`; `results/live-calibration.json`; `hud_env/env.py` |
| **Evidence** | Intent and README require harness/setup/containment failures never count against the model. Live JSON already has `platform_failures`, containment escape, and Claude idle-timeout `exclude` notes — authored by hand. `RolloutObservation` only has `status` (`error` vs `completed`) and unused `failure_tags`. `decide_curriculum` treats `status == "error"` as harness pressure (`repair_harness` if error_rate > 0.25) but cannot express: containment breach, provider idle timeout, workspace escape, reward-policy bug, interrupted run, or “semantic pass / integrity zero”. Containment escape that still returns `completed` with a grade pollutes model rates. |
| **Suggestion** | Introduce a closed outcome enum, e.g. `harness_error | integrity_gate | model_failure | success`, populated at ingest from HUD job status + grade.info + containment probes. Curriculum and EI effect sizes must use **only** `model_failure|success` (and optionally report integrity separately). Fail closed: unknown status → `harness_error`. |

### F5 — High — Budgets are modeled but not frozen into the harness

| | |
| --- | --- |
| **Location** | `variants.py` `Budget`; `adapters.py:39`; `hud_env/tasks.json` `agent_config.max_steps: 80` |
| **Evidence** | EI blueprints declare `TaskComponent.BUDGET` changes (`max_turns` in tests goes 1→4). Exports hardcode `"max_steps": 80`. `Budget.max_tool_calls` / `timeout_seconds` are never read by HUD env, CLI, or calibration. Evolving Intent qualitative claims require matched total tokens/tools/time across static vs multi-turn (knowledge RQ1; paper methods). Unmatched turn inflation confounds “lost in evolving intent” with “got more steps.” |
| **Suggestion** | Single `HarnessBudget` record copied into every public task row and RunRecord. For the EI prototype: **match total max_steps / tool budget / wall time** between static and evolving arms; only the **schedule of user messages** differs. Changing `max_turns` without a matched total budget must be a separate `BUDGET_SHIFT` intervention, never mixed into the EI arm. |

### F6 — High — Verifier policies are aspirational enums; admission overclaims safety

| | |
| --- | --- |
| **Location** | `variants.py` `VerifierPolicy`, `admit_variant` lines 322–335, 343–356; synthesis `controlled-task-variation.md` Failure conditions |
| **Evidence** | Policies `TRANSPORT` / `AUGMENT` / `COMPOSE` / `REPLACE` have no implementers. Admission blocks `REUSE` after behavioral component changes and blocks `CORRUPT`/`REJECT` — good structural guards — but never runs gold, no-op, mutant, leakage, or reset checks listed in the synthesis pipeline. Existing `scripts/admit.py` operates on Recipes, not `TaskVariant`. Passing `admit_variant` therefore means “declared delta consistent,” not “variant is executable or safely graded.” |
| **Suggestion** | Narrow the prototype to `VerifierPolicy.REUSE` only. Gate admission on: trajectory compile + **recipe admit matrix on the shared sealed verifier** + leakage scan of rendered turns. Delete or stub non-REUSE families until a real transport/compose API exists. |

### F7 — High — `clustered_with_source` heuristic is almost always true (wrong independence rule)

| | |
| --- | --- |
| **Location** | `variants.py` lines 358–367 |
| **Evidence** | Clustered unless **all** of: `INITIAL_STATE` changed, `GOAL` changed, and policy ∈ `{REPLACE, TRANSPORT}`. `PERSISTENT_EPISODE` blueprint changes instruction/state/metadata with `REPLACE` but **not** goal → still `clustered_with_source=True`. `GOAL_EXTENSION` with `COMPOSE` changes goal but not initial state → still clustered. `independent_benchmark_task` is always `False` on all ten blueprints. Synthesis says the last four may become new semantic tasks only after new verifier evidence — the code never encodes that transition. |
| **Suggestion** | Default: **all** admitted variants remain one `source_task_cluster` for analysis. Set `independent_benchmark_task` only via an explicit post-admission promotion that requires a new verifier digest and a separate admit matrix. Remove the boolean heuristic. |

### F8 — High — Statistical / curriculum mistakes will mis-steer the loop

| | |
| --- | --- |
| **Location** | `calibration.py` `decide_curriculum`; live calibration N≈4 strong / 3 weak audited |
| **Evidence** | Uses `mean(semantic_reward)` as a “rate”; exact float compare `strong_rate == 0`; harden if `> 0.4` with no CI / no minimum N; ignores `failure_tags`; no paired Δ for static vs EI; no pass@k or bootstrap. README admits sample too small for intervals, yet the controller already emitted `harden` from 4/4. For autoresearch, that threshold will fire on noise and select the next perturbation incorrectly. |
| **Suggestion** | For the prototype: **paired** static vs EI on the same model/harness/budget; report Δ success with binomial/Wilson or bootstrap CI; require minimum completed **model-classified** trials (e.g. ≥20/arm) before any curriculum action other than `repair_harness`. Keep `decide_curriculum` off the EI validation path until then. |

### F9 — High — Reproducibility risks in HUD env and provenance holes

| | |
| --- | --- |
| **Location** | `hud_env/env.py`; `TaskVariant.provenance`; `pyproject.toml`; Dockerfile |
| **Evidence** | `WORKSPACE = tempfile.mkdtemp(...)` at **import** — shared across tasks; concurrent HUD workers race. `_prepare` `git clone`s remote `source` URL every run (network + non-content-addressed beyond revision). `sys.path.insert` into experiment `src`. Grade resolves recipe by **name** glob under `recipes/click`, not by sealed digest. `TaskVariant.provenance` is an optional string tuple never written by any script. Root `pyproject.toml` has `dependencies = []` — no pinned model/harness/runtime for the loop (HUD pinned only inside `hud_env` / Dockerfile as `0.6.12`). Local macOS runs already escaped the workspace (`results/escaped-workspace-click.diff`). |
| **Suggestion** | Per-task workspace; prepare from content-addressed starter artifact (public capsule) rather than live clone when possible; grade by sealed recipe digest; write RunRecord with `{task_digest, variant_digest, recipe_digest, harness_id, model_id, budget, git_sha, container_digest}`. Refuse local non-isolated runtimes for scored loops. |

### F10 — Medium — Ten families before one working arm (complexity budget failure)

| | |
| --- | --- |
| **Location** | `default_variant_blueprints()`; `plan_variants.py`; knowledge synthesis table |
| **Evidence** | 482-line `variants.py` defines 10 families × full enum surface (6 relations, 4 state modes, 6 verifier policies). CLI and tests celebrate “ten contracts.” Zero families execute. Code-quality lens: parameterization for cases that do not exist yet; thin abstraction that will ossify wrong shapes. |
| **Suggestion** | Freeze catalog to **two** executable conditions for v0: `STATIC_BASELINE` and `COMBINED_EVOLUTION` (or hand-scheduled reveal+revise+switch). Keep other families as markdown research backlog, not code. |

### F11 — Medium — Anchor slot encoding is a hidden convention, not a schema

| | |
| --- | --- |
| **Location** | `admit_variant` lines 346–351; tests using `constraint:{index}` |
| **Evidence** | Admission rebuilds `IntentAnchor` as `source.goals[0]` + slots `constraint:{i}` from `source.constraints`. Multi-goal tasks ignore `goals[1:]`. Generators must know this naming. Trajectory targets that use real argument names (as in Evolving Intent “function/arguments”) will fail admission or silently mismatch. |
| **Suggestion** | Store an explicit `IntentAnchor` on the source task (or variant), versioned with the trajectory. Do not reconstruct slots from constraint strings by index. |

### F12 — Medium — `CompiledTrajectory.turns` drops turn indices

| | |
| --- | --- |
| **Location** | `variants.py` lines 284–289 |
| **Evidence** | `turns = tuple(tuple(by_turn[turn]) for turn in sorted(by_turn))` loses the mapping from agent step → messages when turn numbers are sparse or must align with `max_steps`. Runtime schedulers need `(turn, messages)` pairs. |
| **Suggestion** | Return `tuple[tuple[int, tuple[str, ...]], ...]` or a list of scheduled `TurnEnvelope` objects. |

### F13 — Medium — Test suite validates the model, not the research claim

| | |
| --- | --- |
| **Location** | `tests/test_variants.py`, `tests/test_pipeline.py` |
| **Evidence** | Variant tests cover blueprint count, trajectory restore/reject, structural admit, CLI contract emission. No test that: budgets export into `agent_config`; staged mode blocks writes; harness_error excluded from rates; paired EI Δ; provenance schema round-trip; end-to-end fake agent receiving turn 2 reveal. Pipeline tests never import `parallax.variants`. |
| **Suggestion** | Add a deterministic “fake agent” / recorded-trace harness test: inject EI turns, attempt a write during precursor (must no-op or fail closed), grade with reused verifier, emit RunRecord, assert classification. |

### F14 — Low — Integrity/reward conflation already bit live calibration

| | |
| --- | --- |
| **Location** | `grading.py`; NOTES / live-calibration.json |
| **Evidence** | Agents that passed all semantic components scored 0 for allowed-path / pip-cache policy. That is a **reward-policy / harness** defect, not model failure — exactly the separation the loop needs. `Grade` exposes `integrity_gate` and components, but calibration historically collapsed to gated reward until manual audit. |
| **Suggestion** | Always persist `semantic_reward` (contract components) and `integrity_gate` separately in RunRecord; never feed gated reward alone into EI effect estimates. |

---

## Invalid abstractions (summary)

1. **`TaskSpec` as a parallel universe** to `Recipe`/`TaskManifest` without a join key.
2. **`VerifierPolicy` / `StateMode` as enums without runtime or transform implementations** — documentation pretending to be mechanism.
3. **`plan_variants` “ten contracts”** as a substitute for generating and admitting one executable pair.
4. **`clustered_with_source` heuristic** that does not match the synthesis’s independence rule.
5. **`decide_curriculum` thresholds** acting as an autoresearch controller without statistical or classification foundations.

---

## Smallest credible architecture for the first valid prototype

Goal: **reproduce a qualitative Evolving Intent degradation** on one small baseline, with **harness failures excluded** from the effect size.

```text
Versioned source Recipe R0 (already admitted)
  -> TaskIdentity = hash(sealed recipe + starter + budget + harness_id)
  -> Arm A: static prompt, transactional, budget B
  -> Arm B: hand-authored AnchorTrajectory (reveal/revise/switch),
            STAGED writes, same terminal verifier, same total budget B
  -> Frozen harness H (container-only, deny egress, pinned model M)
  -> N paired rollouts
  -> RunRecord JSONL with outcome_class ∈ {harness_error, integrity_gate,
       model_failure, success}
  -> Effect = P(success|A, model-class) - P(success|B, model-class)
  -> If harness_error rate high -> repair_harness (stop)
  -> Else record finding; choose ONE next intervention
       (e.g. function_switch-only vs combined; or budget-matched control)
```

**Implement now (minimal modules):**

| Module | Responsibility |
| --- | --- |
| `parallax.identity` | Digests for recipe, starter, budget, harness |
| `parallax.variants` | Keep trajectory compile + REUSE admission only; drop/ignore unused families |
| `parallax.runtime_ei` | Schedule turns + staged write gate |
| `parallax.records` | RunRecord schema + outcome classifier |
| `parallax.compare` | Paired rates + CI; no curriculum thresholds yet |
| HUD template | `repair` + `repair_evolving` sharing `_prepare` / `_grade` |

**Explicitly defer:** LLM trajectory generation; TRANSPORT/AUGMENT/COMPOSE/REPLACE; persistent episodes; ten-family planner; automatic curriculum harden/simplify; Prime path for this prototype.

**Success criterion:** Same model M, harness H, budget B; Arm B success clearly below Arm A on model-classified trials; harness_error rate reported separately and below an explicit ceiling; one JSONL + one summary table reproducible from git SHA + image digest.

---

## Priority order

1. Bridge one admitted Recipe to a static/EI pair with shared verifier (F1–F3, F6).
2. Freeze and match budgets into HUD agent_config (F5).
3. Outcome classifier + RunRecord provenance (F4, F9, F14).
4. Paired stats; disable curriculum thresholds for this study (F8).
5. Delete or quarantine unused variant families and dual-spec drift (F2, F7, F10).

Until steps 1–4 exist, additional blueprints and knowledge notes do not advance the autoresearch loop.
