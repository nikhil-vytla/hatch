# Jev experiments

[Open the deployed laboratory](https://jev-experiments.vercel.app). It contains 25 visual experiment views, recorded evidence, editable live inputs, local model composition, and downloadable results. The app uses Bun, Vite, TypeScript, procedural SVG/canvas, Web Audio, and a Vercel function. The research runner uses Python. All implementation code in this folder is new; dependencies and fetched repositories are excluded.

The useful pattern is to let Jev make many bounded judgments while other components do the writing, perception, rendering, training, and bookkeeping. Jev is text-only and returns choices, ordered scores, and yes/no probabilities. It does not directly generate a website, a caption, a waveform, or a paragraph. Those outputs become possible when its decisions control another system. [TypeSafe's documentation](https://docs.typesafe.ai/introduction) explains the underlying API contract.

## What is built

| Gallery views | What actually runs |
| --- | --- |
| Procedural worlds, pixel drawing, logos | Jev selects scene attributes, 64 pixel colors, or a vector grammar; code renders the output and exposes probabilities. |
| Generative UI, user journeys | Layout and field selection, revision checks, and a beverage flow that asks for clarification before confirmation. |
| Music | Eight symbolic note and duration decisions, local synthesis, and MIDI export. |
| Beverage ordering | Menu-grounded matching, preference extraction, conflict detection, and a local confirmation demo. |
| Decision matrix | Separate rubric scores with immediately adjustable weights calculated in code. |
| Navigation | MiniGrid random, visible BFS, reactive Jev, and Jev with action history, with step-by-step replay. |
| Task routing, agent verifier, micro-agent | Bounded handler selection, completion-evidence checks, and a small route/retrieve/verify composition. |
| Search, context protection | Document selection, relevance and injection judgments, source retention, and measurable context reduction. |
| Classification, judging, robustness, latency | Public dataset comparisons, answer-order swaps, representation interventions, and state-size/question-count sweeps. |
| Prompt optimization | Unchanged prompt, random mutation, hill climbing, OPRO-inspired proposals, and the real GEPA library. |
| Labeling, reward training | A teacher-labeled local classifier and a linear policy trained with Jev rewards. Both export weights that run in the browser. |
| Kev-style replication | A different backbone, SmolLM2-360M, with isolated question branches, LoRA, and a trained pointer head. |
| Local writer plus Jev | Four Qwen3-0.6B candidates, Jev selection, official instruction checks, continuation steering, and a phrase-chain experiment. |
| Vision plus Jev | Browser-local ViT-GPT2 captions an image; Jev evaluates the resulting text. |
| Typed adapters | Pydantic, Zod, Rust Serde/Schemars, and Go JSON Schema plus validator. Values and probability evidence survive decoding. |

Some views share a measured run: worlds and pixels, search and context, beverage and journeys. The 25 cards are not 25 independent benchmark datasets. The [source review](SOURCES.md) explains community precedents, including [aaazzam/jev](https://github.com/aaazzam/jev). The [idea garden](IDEA_GARDEN.md) proposes 20 further directions with concrete falsifiable tests.

## Findings

The strongest lesson is to keep a simple baseline. On Banking77, trained TF-IDF plus logistic regression beat Jev. On CLINC, Jev's aggregate advantage came from recognizing out-of-scope requests, while the baseline remained stronger within known intents.

| Evaluation | Jev or composed system | Comparison and scope |
| --- | --- | --- |
| Banking77 | 72.21% over 385 attempts; 81.29% among 342 answered | TF-IDF logistic 89.09%; five test cases per intent |
| CLINC150 + OOS | 82.50% over 400 attempts; 88.24% among 374 answered | TF-IDF logistic 70.50%; 300 in-scope and 100 OOS cases |
| CLINC in-scope only | 84.00% over 300 attempts | TF-IDF logistic 89.67% |
| CLINC OOS only | 78.00% over 100 attempts | TF-IDF logistic 13.00% |
| JudgeBench | 72.00% over 200 ordered attempts; 77.42% among 186 answered | 100 underlying pairs, each asked both ways; 27.78% order disagreement among pairs answered in both orders |
| Local writing, official IFEval checks | Jev selection passed 23/40 | First Qwen candidate 21/40; best-of-four oracle 30/40; Gemini Flash-Lite reference 35/40 |
| SmolLM2 decision model | Four-way choice 32.47% before, 66.23% after | 77 held-out records; yes/no stayed at 40.26%, score argmax rose from 33.77% to 45.45% |
| Reward training | 63.75% independent menu accuracy after 240 updates | 44 successful training annotations; 80 held-out authored examples; a linear policy, not LLM RLHF |
| Teacher labeling | Random acquisition 53.75%; uncertainty acquisition 52.50% | 32 attempted labels per method, shared initial eight, 80 held-out authored examples |

The paired 95% bootstrap interval for Jev minus the baseline is -21.82 to -11.95 percentage points on Banking77 and +6.5 to +17.5 points on the chosen CLINC mixture. These intervals count request failures as incorrect and resample underlying cases. They do not remove sampling or dataset-design limitations.

The writing comparison is a five-point improvement from selection, with additional local compute for generating four candidates. It does not demonstrate better creative writing: the 20 creative prompts have no human preference labels. Sonnet was initially requested as a reference and prompt writer, but this account received HTTP 403. The completed reference and optimization runs use permitted Gemini 2.5 Flash-Lite, paced to its account limit. Local Qwen and the trained SmolLM2 model serve separate roles.

Prompt optimization did not improve the 50-case held-out result in this bounded run. Unchanged, random mutation, hill climbing, and GEPA each reached 86%; OPRO reached 84%. GEPA retained the original prompt as its best candidate. Random, hill climbing, and OPRO used 240 classified validation records each; GEPA used 250. This is useful negative evidence: a working optimizer is not a guarantee of better generalization. The task covered ten Banking77 intents, with only 20 validation examples, and all methods used the same ten-record request packing.

The vision smoke test exposed a real failure: the captioner described a screenshot of this gallery as electronic devices. Jev assigned only 0.25 to sufficient evidence, but it could not inspect the missing pixels. A better composition needs regions, crops, OCR, or a stronger perception model, followed by independent checks.

Small authored routing, search, beverage, UI, and verifier fixtures establish that the integrations run. They are not broad accuracy claims. Verifier variants repeat five underlying templates. The context filter is a heuristic, not an authorization or security boundary. Jev's confidence is distribution-derived; the benchmark calibration measurements are separate evidence.

The final small reruns answered 5/5 search cases correctly, 20/20 verifier variants correctly, 19/20 routing cases correctly with one request failure, and 23/24 beverage cases correctly with one request failure. Earlier runs were dominated by overload errors. Both attempts appear in the run history, so these improved completion rates should not be mistaken for an improvement to the model itself.

The latest optimization and navigation tables are in the app and in [optimization results](results/optimize.json) and [navigation results](results/games.json). Navigation uses exact-state decision caching, including history for the memory policy. Every step records cache use. Shared decisions mean the 30-seed episodes are not independent fresh model samples. All policies use the same partial observations and a 64-step limit.

All 240 navigation episodes completed. In the empty room, success was 70% for random actions, 100% for visible BFS, 0% for reactive Jev, and 100% for Jev with recent actions. In DoorKey, success was 6.7%, 100%, 46.7%, and 96.7% respectively; the memory policy had one request failure. The empty-room task repeats the same layout across seeds, and cached judgments are shared. This is evidence that recent actions can break a policy's loops in this tiny environment, not evidence of general planning ability. The exact geometric baseline remains better. The run used 419 distinct cached request states and reused decisions on 3,886 steps.

## Evidence and reproducibility

`results/*.json` contains the published measurements, source pins, split IDs, distributions, failures, and model metadata. `results/history.json` lists failed, interrupted, and superseded runs. The gallery selects the latest complete or partial run; it does not silently reinterpret a missing result as success. A separate Gemini pass reused existing Qwen candidates and Jev choices, and a corrected GEPA run reused completed validation searches without changing their prompts from test outcomes.

Navigation publication removes duplicated observations without dropping frames: `frame.state_id` indexes the result's `observations` array. This keeps the complete replay small enough to load comfortably. Local `runs/` files retain the original expanded traces.

The shared SQLite ledger reserves each API attempt before sending it, enforces four in-flight requests, and stops at $25 conservatively accounted or 10,000 attempts. Unknown cost metadata remains reserved. Reported charges and conservative accounting are different numbers; the homepage displays both. Jev returned zero reported charges during the promotion, but many 429 errors returned no cost metadata. `jev-lab budget` shows the current local ledger.

Early classification and judge rows recorded only the successful final attempt's latency. Their result files and UI explicitly say so, and `transport` reconstructs retry-aware durations from attempt timestamps. The latency sweep records gateway elapsed time, not pure inference time. The model alias did not reveal the underlying Jev version.

The 120-request latency sweep completed 118 requests. With 1,000 state words, median gateway elapsed time was 342 ms for one question and 368 ms for 128 questions, but p95 was about 10.5 seconds because of retries. This supports batching many questions in a call; it does not establish consistently low tail latency. The 40-case robustness sweep includes an identical-repeat control, whose answered count changed too. Availability noise must be separated from representation sensitivity before drawing a strong conclusion.

The recorded work ran on Apple Silicon with MPS. Local browser models are downloaded only when those demos are opened and run. The browser's quantized ONNX writer differs from the Python benchmark's FP16 model. The included [model card](artifacts/MODEL_CARD.md) explains the 914 KB trained SmolLM2 adapter/head and its limitations. No base-model weights or fetched source repositories are committed.

## Run it

From this folder, install Python dependencies and start the loopback API:

```sh
uv sync --extra dev --extra train
.venv/bin/jev-lab serve
```

In another terminal:

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

The Vite development server proxies `/api/evaluate` to `127.0.0.1:8792`. Use its printed URL. The runner reads `AI_GATEWAY_API_KEY` from the environment or a literal assignment in `~/.zshrc`; it never executes that file. The key is never sent to the browser or written into results.

```sh
.venv/bin/jev-lab list
.venv/bin/jev-lab run search
.venv/bin/jev-lab run games --quick
.venv/bin/jev-lab batch classify judge robustness latency
.venv/bin/jev-lab run optimize
.venv/bin/jev-lab run replica
.venv/bin/jev-lab run language
.venv/bin/jev-lab report
.venv/bin/jev-lab budget
```

`--quick` marks an integration pilot with smaller counts. Full training and language runs download model weights. Re-running an experiment creates a new timestamped directory in ignored `runs/`; raw requests and checkpoints remain there. Public-source downloads and model/toolchain caches stay in ignored `.cache/`. `JEV_WRITER_MODEL` can override the permitted writer default when the account has access to another model.

Use the saved replica without a cloud model call:

```sh
.venv/bin/python -m jev_lab.replica_infer 'Please refund my purchase.'
```

Typed adapter code lives under `adapters/`. Each compiler accepts a deliberate subset of JSON Schema. Free-form strings, optional outputs, recursive schemas, and unsupported domains fail explicitly. TypeScript, Rust, and Go support an explicit ordered-score rubric; Python currently supports finite choices, booleans, probabilities, and nesting. The same live response was independently decoded in all four languages with identical typed values and preserved evidence.

## Deployment and validation

The production URL is [jev-experiments.vercel.app](https://jev-experiments.vercel.app). Replay is public. Live calls require the separate private lab token, stored locally in `.cache/live-access-token` with mode 0600. Paste it into "Unlock live calls"; it stays in browser session storage. The token and gateway key are sensitive Vercel environment variables. Neither is part of the repository.

The function validates request sizes, supported types, returned distributions, and authorization. It limits requests per warm function instance. Those limits are not a durable global quota, and production live calls do not pass through the local research ledger. The gateway account's own limits still apply. Live browser inputs are not added to the published benchmark.

```sh
.venv/bin/jev-lab deploy
.venv/bin/jev-lab cloudcheck
```

The deployment command uses Bun and the Vercel CLI. A new Vercel project needs `deploy --configure` to set its two secrets through stdin. This project's private GitHub connection was unavailable, so deployment uses the local project rather than a Git integration.

Validation includes Python contract, budget, mask, reward-update, and sklearn/browser parity tests; TypeScript adapter tests and compilation; Rust and Go tests; and the production build. Browser checks exercised desktop/mobile layouts, local inference, local vision and writing, and interactive controls. Production checks returned 401 without a token, 400 for malformed authorized input, and 200 for a valid authorized judgment. See [NOTES.md](NOTES.md) for changes and observed failures, and [architecture decisions](agents/adrs/README.md) for the reasoning behind the experiment design.

```sh
.venv/bin/pytest -q
.venv/bin/ruff check src tests
cd web
bun run build
# In adapters/typescript: bun test && bunx tsc --noEmit
# In adapters/rust: cargo test
# In adapters/go: go test ./...
```
