# Live telecom campaign and budget proof

The live path uses one manifest `[budget]` and the existing M3 ledger. Paid calls remain disabled on macOS. The orchestrator must run the Linux qualification and five-cent proof before the pilot. No live proof has been run by the implementation agent.

The actor runs OpenCode 1.18.30 with a local AI SDK provider that sends one request through an inherited pipe. The existing Linux jail still denies external networking and access to host credentials. Only the parent gateway reads `OPENAI_API_KEY`. The tau2 user simulator captures its request without calling LiteLLM; Strive's direct user adapter generates the response. Telecom tools and deterministic scoring use the pinned tau2 worker and operation store.

## Price and reservation

[OpenAI Standard pricing](https://developers.openai.com/api/docs/pricing), retrieved September 10, 2026, lists Luna input/cached input/cache write/output at $0.20/$0.02/$0.25/$1.20 per million short-context tokens. The corresponding long-context rates are $0.40/$0.04/$0.50/$1.80. The dated artifact is `prices/openai-2026-09-10.json`; its content digest enters the resolved manifest and provider bound.

Requests fix `service_tier=default` and use explicit-only caching with no breakpoints. [OpenAI's caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) states this disables cache reads and writes. Hosted tools, sessions, background generation, retries, regional endpoints, and price fallback are unavailable. Both models reserve 32,768 input tokens and 1,024 total output tokens, including reasoning. The reservation is **$0.0077824 per generation**. Strive calls the [input token counting endpoint](https://developers.openai.com/api/docs/guides/token-counting) after reservation and before paid generation; an exact count above 32,768 prevents paid dispatch. This avoids estimating message/schema overhead with a local tokenizer.

M3 admits each request only when settled usage + outstanding reservations + the proposed reservation fit every resource limit. Provider usage receipts replace known reservation components. Unknown usage keeps its obligation. An overrun is recorded and stops further dispatch. A refused campaign reservation records `campaign.budget_stop`, suspends with its current episode/continuation, and prevents further campaign dispatch. Reopening the same run retains the same ledger and budget; a larger replacement budget is rejected.

## Container runs

Build the existing base image and the live image. Installation and qualification make no paid calls.

```sh
docker build -t strive-vnext -f Containerfile .
docker build -t strive-live -f live-tau2-budget-proof/Containerfile.live .
mkdir -p live-results
docker run --rm --privileged --cgroupns=private \
  -v "$PWD/live-results:/results" strive-live qualify
```

The image retains the pinned tau2 installation/data and OpenCode binary. Run artifacts must stay mounted at `/results` across resumes. Do not rebuild with changed source and expect an old run to resume: implementation hashes are checked.

Run the cheap proof first. Expected inference spend is roughly **4.2–5 cents**, with a $0.05 ceiling. Its deterministic assertions check observed execution; live model output itself is not deterministic. The task stream repeats the five selected adaptive-development tasks until the next reservation is refused. A timeout, provider failure, missing receipt, overrun, or normal workload completion fails the proof.

```sh
docker run --rm --privileged --cgroupns=private -e OPENAI_API_KEY \
  -v "$PWD/live-results:/results" strive-live \
  budget-stop-live live-tau2-budget-proof/budget-stop-5c.toml --id budget-stop-5c
```

The successful result is `/results/runs/budget-stop-5c/budget-proof.json`. It must say `status: passed` and `live: true`, include real provider response IDs and retained receipt hashes, reconcile receipt prices to settled ledger spend, identify the refused USD reservation, show zero unknown USD and zero overruns, and show `dispatches_after_stop: 0`. The checker retries both campaign driving and the refused command after the stop. It separately asks the unchanged broker to prepare that command and requires the M3 budget-denial error. Scripted receipts cannot pass the `live: true` check.

Start with one episode, or change `--episodes 1` to `--episodes 3`. This is a work horizon, not a second budget. Expected cost is unknown until measured; the only authorized ceiling is the manifest's **$5 total**. Each generation is bounded by $0.0077824. For illustration, 20 generations cost at most $0.155648 and 100 cost at most $0.77824; actual episode counts and costs must be measured.

```sh
docker run --rm --privileged --cgroupns=private -e OPENAI_API_KEY \
  -v "$PWD/live-results:/results" strive-live \
  campaign live-tau2-budget-proof/pilot-5usd.toml --id telecom-pilot --episodes 1
```

Inspect `campaign-result.json`, `resolved-manifest.json`, and the verified ledger before continuing. Resume the same run for the remaining selected episodes. This preserves spending from the first episode; creating a new run ID would create a separate $5 budget.

```sh
docker run --rm --privileged --cgroupns=private -e OPENAI_API_KEY \
  -v "$PWD/live-results:/results" strive-live \
  campaign live-tau2-budget-proof/pilot-5usd.toml --id telecom-pilot --resume
```

The pilot runs at most five episodes and may finish below $5. Its other caps are 5,000,000 tokens, 1,000 model calls, and 14,400 active wall seconds. The wall ledger records active model invocation time, including provider counting and harness execution; offline preparation and unmetered local scoring are not a campaign elapsed-time deadline. The fixed actor does not refine during this cost pilot; the manifest includes refinement/retries for the single-budget contract but neither dispatches here. Selected tasks must belong to the qualified adaptive development split, never validation/audit.

`pilot-5usd.toml` is the portable authored input. Full resolution requires the actual Linux executable, jail and tau2 closure; the runner writes the resolved configuration with artifact hashes before any dispatch. Use `campaign ... --prepare-only` for that artifact without generation, then use the same ID with `--resume`.

## Validation record

Run the no-spend campaign checks and strict type check with:

```sh
uv run --no-sync pytest tests/vnext/test_live_campaign.py -q
uv run --no-sync mypy --strict
```

The tests cover an exact USD ceiling shared by actor and user, lower measured usage releasing unused reservation, repeated episodes, mid-episode pause/resume, refusal to replace the budget, unknown prices/usage, provider overruns, and counting before paid dispatch without retries.

The new campaign suite passed **11 tests**, with the Linux native-jail test skipped on macOS. Strict mypy passed for **188 source files**. [Saved scripted proof results](scripted-budget-proofs.json) show both exact-ceiling admission and release of unused reservations; every receipt is explicitly scripted and `live` is false. A direct Hatchling wheel build passed and includes the native provider module and existing policy data.

The [full host suite](host-suite.txt) finished with **794 passed, 26 skipped, 1 xfailed, 3 failed**. One audit-workflow failure was the runtime pin correctly rejecting source edits made while the suite ran; its [isolated rerun passed](audit-rerun.txt). The remaining two packaging tests hit a `uv 0.9.18` macOS system-configuration panic before building a wheel; see [the captured failure](packaging-failure.txt). The host suite therefore does not have an all-green result in this sandbox. No assertions were weakened. Linux native qualification and the paid budget proof are intentionally left to the orchestrator. [All 30 frozen hashes match](frozen-core-check.json); no baseline was refreshed. No commit or PR was created. The [implementation diff](changes.patch) includes new source and changes to existing code, with no fetched repository copies.
