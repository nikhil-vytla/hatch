# M7: complete the research workflow

M7 composes the existing vNext runtime into a local research workflow. The fixture runner resolves and retains the frozen manifest types, executes the M5 counter benchmark through Deno and the M6 refinement policy, and produces journal-derived reports. Development and blind audit runs have separate execution state and a one-way frozen-actor handoff. No paid model calls, commits, PRs or history changes are part of this work.

## Commands

From the repository root, make the separately packaged counter adapter available:

```sh
export PYTHONPATH="$PWD/adapters/counter/src${PYTHONPATH:+:$PYTHONPATH}"
export UV_NO_SYNC=1 UV_OFFLINE=1
export UV_CACHE_DIR="$PWD/m7-research-workflow/.uv-cache"

uv run strive --root m7-research-workflow/.smoke-cli run m7-research-workflow/examples/counter.toml --id adapting-17
uv run strive --root m7-research-workflow/.smoke-cli resume adapting-17
uv run strive --root m7-research-workflow/.smoke-cli run m7-research-workflow/examples/fixed.toml --id fixed-17
uv run strive --root m7-research-workflow/.smoke-cli compare fixed-17 adapting-17 --spec m7-research-workflow/examples/paired.toml
uv run strive --root m7-research-workflow/.smoke-cli status adapting-17 --follow
uv run strive --root m7-research-workflow/.smoke-study experiment m7-research-workflow/examples/study.toml
```

`uv run python -m strive.vnext.cli` exposes the same commands. Legacy flag-based commands remain available through the existing CLI. `status --invocation EFFECT_OR_INVOCATION_ID` narrows the retained model-input view. `compare --out DIRECTORY` writes Markdown, JSON and CSV, including authoritative event IDs and artifact references. The descriptive example uses the same exports without a controlled-improvement estimate.

`run` exclusively creates an identity, retains authored and resolved configuration, validates pins and provider bounds, and flushes its resolved-config display before dispatch. Failed or interrupted setup never makes an identity reusable. `resume` reads the original binding, immutable artifacts, service databases, continuation and folded ledger; scientific overrides are rejected. It requires the installed runtime to match the retained implementation, and never substitutes newer source or a newer model. Restoring a pinned execution environment is separate from replay.

The supplied provider is deterministic and makes no network calls. The actor runs as bounded JavaScript, while the refiner response crosses the real model gateway and accounting path. The fixture actor starts with delta 1; its recorded refiner proposal changes the prompt to delta 7. Trusted counter outcomes are 0 then 1 for the adapting trajectory and 0 then 0 for the fixed trajectory.

The installed-command smoke study completed both declared repetitions in both arms, followed by four isolated audit runs. Each fixed trajectory scored 0/2 during development and 0/2 at audit. Each adapting trajectory scored 1/2 during development; its frozen final actor scored 2/2 at audit. All 16 planned episode outcomes were measured. These deterministic fixture results validate the workflow; they are not evidence about a live model. The separate outcome and accounting summaries are retained in `smoke-outcomes.json`.

In the fixture policy, empty editable scope disables refinement. The fixed arm can leave its unused model allocation unspent. Resolution retains the Deno executable bytes, Python/runtime source identity, initial memory, complete bundle, model bounds, and argument/result schemas. Large runtime artifacts stay in the ignored execution stores and are not source deliverables.

## Study allocation and audit

The example study declares fixed and adapting arms, two paired workload seeds, identical per-repetition ceilings, a total development allocation, a separate audit allocation and an analysis plan. The wrapper durably records every arm/repetition/run identity before setup. It snapshots local authoring inputs and resolves every run before dispatching the first arm. Restart resumes those identities, including previously completed runs, instead of creating fresh repetitions. There is no scheduler service.

Selection is predeclared as `final_valid_active_actor_from_every_trajectory`. Freeze records each development journal head and selected bundle, installs per-run barriers while holding workflow leases, and refuses concurrent active sessions. A frozen development run cannot resume. Audit copies only the selected actor files into a new immutable actor bundle and scope; the original selected reference and exact imported bytes remain in the audit's handoff record.

Audit owns separate CAS and journals, mutable environments, operation receipts, grant and bundle registries, retrieval indexes, caches, provider conversation state, gateway spools, accounting and report destinations. No audit callback or service handle enters the development policy. Ordinary benchmark state can evolve inside audit runs. A release marker must match the frozen import before workflow reporting or telemetry exposes audit content. Authorized audit reports live under `audit/<study>/reports`, and cannot select another candidate or reopen development.

The noninterference probe holds permitted inputs, runtime-duration observations and recorded model completions fixed. It changes the protected target from 7 to 8, changing audit scores from 1 to 0, and varies audit-only traces, memories, prompts, scores, dashboards, stop signals, budget data, messages, retrieval, cache and conversation data. It compares adaptive requests, commands, private state, environment, active bundle, spending and all record payloads byte for byte. It also checks that audit execution does not change any development file. Identical content may independently exist in two CAS stores; the test checks access scope and audit-only data rather than treating digest equality as leakage.

## Reports and inspection

Reports preserve planned, admitted, completed, failed, excluded and unresolved coverage, including allocated executions with unavailable setup/history. Task failures with trusted scores remain completed measurements. Missing outcomes have separate bounds; uncertainty intervals never stand in for missing outcomes. The supported interval is a predeclared 95% normal approximation over complete paired trajectories, with no interval for one pair and an explicit small-sample limitation.

Matched comparison checks workload, snapshots, scorer, model settings, budgets, seeds, corpus, recovery and retained closure conditions. It expands initial actor and policy trees into file-content conditions. Declaring a policy intervention cannot hide an unrelated actor-file change. Descriptive comparison reports differences without a controlled-improvement claim.

Execution integrity and measurement provenance, feedback exposure, and comparison strength remain three separate labels. Only authenticated `Measurement` records populate official tables. Candidate claims and judge assessments have separate sections with producer and event provenance. Costs, reservations and unknown usage come from the verifier's ledger fold. Expenditure is never read from telemetry spans.

Retention compares the first and last observed exposure of repeated development-corpus tasks. It labels that method and lists unmeasured corpus tasks. It does not invent an independent regression evaluation or claim that deferred forks executed. Model inspection retains the exact provider request and supplied component bytes, with byte ranges only when directly available. The label is `sent to the model`; supplied context does not prove causal influence.

Live inspection captures complete frames using the existing journal reader, then authenticates that prefix with the pure verifier. Each status update and export uses one consistent fold. Concurrent appends and incomplete tails have explicit inspection diagnostics. Damaged committed frames remain errors; inspection never truncates a tail or acquires a writer lease. Execution and recovery retain the original strict file reader.

## Telemetry

`strive project RUN` is an optional separate consumer. Without an endpoint it uses an in-memory exporter. `--profile langfuse`, `--profile langsmith` and `--profile phoenix` select presentation mappings without changing policy code. The resolved manifest supplies the default profile. `--rebuild` discards the need for a prior cursor and reprojects history. An explicit `--endpoint https://HOST/.../v1/traces` enables OTLP/HTTP JSON export; credentials can be supplied through the Python exporter's external headers, not archived manifests.

Audit projection requires `--destination audit:reference` and the matching `--audit-release` marker. HTTP audit export additionally requires `--development-endpoint` to declare the development route, and rejects the same normalized endpoint. This implementation requires separate endpoints; shared-endpoint credential ACLs are not treated as a proven boundary. Endpoint operators remain responsible for their server's access controls.

The canonical projection uses workflow, agent, model-operation and tool spans, stable identities derived from execution identities, exact event/artifact references, requested/observed model identity and available usage. Costs appear only on leaf model effects. Optional cumulative duration/token histograms use the standard metric names and low-cardinality operation/provider/model/token-type labels. Viewer destinations that accept only traces need no metrics endpoint.

An exporter outage leaves a visible cursor/backlog without modifying execution history. Deleting the cursor rebuilds the projection. The fixture exporter upserts stable span identities, while official financial and research totals always come from journal folds. OTLP itself does not promise exactly-once ingestion. No runtime, policy, benchmark, store, harness or verifier module imports telemetry or reporting.

The frozen event format has no absolute dispatch timestamp. Projection therefore uses an explicitly labeled relative time axis based on broker-observed durations, with missing duration remaining missing. It does not manufacture latency from export time. Absolute wall-clock correlation would need separately retained clock observations; this implementation makes no such timing claim.

The pin and mappings follow the primary documentation: [OTel GenAI 1.41.0 agent spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-agent-spans.md), [model spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-spans.md), [metrics](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-metrics.md), [Langfuse](https://langfuse.com/integrations/native/opentelemetry), [LangSmith](https://docs.langchain.com/langsmith/trace-with-opentelemetry) and [Phoenix](https://arize.com/docs/phoenix/tracing/concepts-tracing/translating-conventions).

## Decisions where the specification leaves choices

- Arm allocations are per repetition. The total allocation covers development; audit has an additional, separate ceiling.
- Empty editable scope defines the fixed arm and disables refinement. Equal budget ceilings do not require equal spending.
- The executable study is the requested counter reference shape with exact fixture providers. Unsupported scientific settings fail validation rather than silently substituting a model or workload.
- Uncertainty uses the declared paired normal approximation; fewer than two complete pairs yields no interval. Retention uses observed repeated development exposures, with unmeasured corpus items explicit.
- A live inspector reports an authenticated complete prefix. An unfinished tail remains visible and requires explicit recovery for execution.
- Telemetry time is relative because the frozen journal lacks absolute dispatch times. Audit HTTP export requires a distinct declared endpoint; external access controls remain the destination operator's responsibility.

## Files and verification

Implementation is in `src/strive/vnext/cli/`, `study/`, `report/` and `telemetry/`. The existing `src/strive/cli.py` has a small routing addition that preserves legacy commands. Deterministic tests and fixture helpers are under `tests/vnext/`. This folder contains example TOML files, notes, retained test results, the final summary and a diff of modifications to existing files.

Final verification, with implementation and test source unchanged throughout the run:

- Full vNext suite: **441 passed, 10 skipped, 3 xfailed in 1004.19 seconds**. See [pytest-vnext-final.txt](pytest-vnext-final.txt).
- `uv run mypy --strict`: **no issues in 168 source files**. See [mypy-final.txt](mypy-final.txt).
- Installed CLI smoke: all **8 command steps succeeded**, including matched/descriptive comparison, a complete two-repetition study and in-memory projection. See [command-smoke.json](command-smoke.json).
- The combined guarantee-2 acceptance test passes both forged-facts rejection and protected-feedback noninterference. The full suite includes fresh-interpreter pure replay and projector-outage/re-export tests.
- **30/30 frozen core hashes match**. No frozen core, gateway, supervisor, broker, admission or ledger file changed. The 27 implementation/test hashes match the retained verification snapshot; `git diff --check` is clean. See [core-integrity.json](core-integrity.json), [verified-sources.json](verified-sources.json) and [existing-changes.diff](existing-changes.diff).
- The only modified pre-existing files are the legacy CLI router and the acceptance-test driver/docstring. New source and tests are listed in [FILES.txt](FILES.txt). No commit, PR or history change was made; the branch remains `strive-astra`.

The three expected failures are `test_runtime_integrity_1_confines_candidate_and_harness`, `test_production_os_confinement_floor` and `test_evaluate_fork_enactment_deferred`. The ten skips cover three unqualified native CLIs, three funded live smokes, one localhost-TCP restriction and three tau2 installation/inventory gates. Deterministic tests block external network connections and use no paid providers. Earlier verification also passed all five legacy CLI checks; their log is retained.

## Rebuild status and release gates

Guarantees 3, 4 and 5 already have runtime enforcement from M2–M6. M7 adds campaign-level protected-feedback noninterference to guarantee 2's existing forged-facts protection; its combined acceptance result is recorded with the final test results. Guarantee 1's native OS jail remains deferred, as does the production confinement floor. Deno permission and bounded fixture tests do not qualify a native harness jail.

| Guarantee | Final implementation scope |
|---|---|
| 1. Confinement and fixed authority | Candidate and Deno fixture permissions tested; native OS jail and production confinement remain deferred. |
| 2. Independent facts | Trusted producer/scorer facts plus isolated, frozen audit lineage; combined forged-facts and protected-feedback probe enabled. |
| 3. Durable execution identity | Existing request retention, identity, reservation, executable-bundle and single-consumption enforcement preserved. |
| 4. Honest recovery | Existing reconciliation, mutation retention, uncertainty and spent-budget preservation retained by resume. |
| 5. Small checked protocol | Existing pure preflight and replay preserved; inspection consumes authenticated prefixes without changing execution verification. |

The full funded telecom study is still gated on an explicit funded ceiling and protected audit allocation, a successfully installed and retained tau2 environment, complete task qualification and scorer equivalence, and production OS confinement. The M7 executable example is the deterministic counter reference shape. EvaluateFork enactment remains unsupported and retains its honest xfail; it needs the separately approved authorization/accounting core work already identified in M6. The two pre-existing macOS uv-build packaging failures are outside this milestone.
