# Jev experiment notebook

## 2026-09-19: planning and setup

- The brief is deliberately broad: investigate Jev as a general-purpose classifier that can support games, decisions, worlds, interfaces, evaluators, optimizers, and local models. Do not select a flagship experiment before comparing the pilots.
- The user approved a $25 first-pass API ceiling and said the gateway key already has its own budget. The key is named `AI_GATEWAY_API_KEY` in the shell configuration. Its value has not been printed or copied into this project.
- Planning research found native choices, ordered scores, and yes/no probabilities; text-only inputs; parallel independent questions; and provider confidence derived from the answer distribution. Confidence is not an independent correctness estimate.
- Vercel supports `/v1/evaluate` and `/typesafe/v1/systemone`. Chat completions do not support Jev. The model alias is `typesafe-ai/jev`.
- TypeSafe lists $0.042 per million input tokens, free outputs, a 64k combined request limit, and 32k for state plus the longest question. Gateway pages showed promotional free pricing ending September 25 and an older $0.04 listing. Record actual charges instead of assuming free access.
- Relevant precedents: achimala/jev-paint, joevidev/ui-generator-instinct-jev, AbdelStark/heist-one, sutro-sh/jev-align, jaredpalmer/kev, and Pydantic's TypeSafe integration. Source links will be maintained in SOURCES.md.
- Known limitations worth testing: numeric precision, long irrelevant state, indirection, adversarial text, option/representation sensitivity, and chained-choice text generation. These are experimental questions, not reasons to avoid creative work.
- Environment: Apple Silicon, Chrome, Node, Bun, uv, and Python are available; Ollama is not installed. Git's file monitor failed during exploration, so read-only Git checks use `-c core.fsmonitor=false`.
- Plan Mode allowed research but no writes or paid calls. Implementation starts now; no results are claimed yet.

## Implementation observations

- The first authenticated three-primitive smoke test completed in 760 ms; Vercel reported $0. Its returned model is the gateway alias, so an underlying Jev version cannot be asserted from that response.
- Launching an interactive shell did not export the configured key, and triggered shell-cache permissions noise. The runner now reads only the literal `AI_GATEWAY_API_KEY` assignment when no environment variable is set. It does not execute the shell file.
- The sandbox blocks Python DNS/network access. Live CLI runs use the approved `.venv/bin/jev-lab` command prefix outside the sandbox. Offline work uses the project virtual environment directly.
- Initial concurrent benchmark calls encountered upstream 429 high-demand responses. These attempts stay in the ledger and logs. Missing cost metadata remains a conservative reservation; it is not falsely reported as a paid charge.
- Expanded brief: reward-based training, agent verification, task routing, local vision plus Jev, labeling, generative logos and journeys, search/navigation, context filtering, micro-agents, beverage ordering, and music. Add connected runnable pilots while keeping model preference distinct from independent success.
- The user also requested a deployed minimalist Vercel app, a Kev-style replication with a different base model, and typed-function adapters inspired by aaazzam/jev. Vercel CLI authenticates successfully as nikhil-vytla.
- Inspected aaazzam/jev: its decorator compiles annotations into questions and validates returned values, but discards distributions. Our cross-language adapters will retain typed values and the original probability evidence. Numeric score levels must be explicitly described rather than presented as an exact-number extractor.
- Inspected Kev's implementation: shared state, isolated question branches, reused position IDs, a pointer readout, and LoRA on a causal backbone. Replicate the mechanism with HuggingFaceTB/SmolLM2-360M, not Qwen. This is an architecture transfer pilot, not a reproduction of Kev's reported benchmark quality or TypeSafe's undisclosed weights.
- SmolLM2 uses bare `layers.*` module names in `AutoModel`; PEFT's numeric layer selector failed to match those names. Switched to an explicit module-name expression covering the final eight layers. The failed run remains recorded.
- Added a filesystem lock around public-source pinning so concurrent runners cannot overwrite each other's source manifests.

## Measured pilots and app, 2026-09-20 UTC

- Completed Banking77, CLINC150, and JudgeBench runs. Banking77 favored the trained TF-IDF baseline; CLINC150 favored Jev under this sample mix. Both all-attempt and answered-only accuracies are reported because upstream 429s were common.
- The original classify/judge process versions measured successful final-attempt latency. Publication now reconstructs retry-aware transport durations from timestamps and labels the older row timing correctly. Request failures remain in accuracy denominators.
- SmolLM2-360M completed 240 real training updates. Four-way choice accuracy rose from 32.5% to 66.2% on 77 held-out cases. Yes/no stayed at 40.3%; ordinal endpoint accuracy rose from 33.8% to 45.5%. Packed versus separate questions differed by at most 1.64e-6 in a one-example numerical check. These mixed results do not reproduce Kev's quality claims.
- The reward pilot updates a linear contextual-bandit policy, not an LLM. It reached 63.75% independent menu accuracy. The labeling pilot's uncertainty acquisition did not beat random acquisition at 32 labels in this run.
- Pydantic, Zod, Serde/Schemars, and Go JSON Schema plus validator decoded one live Jev response to identical typed values while retaining the full answer evidence. Tests cover unsupported schemas, invalid values, malformed distributions, and local references.
- Rust was present only as rustup shims without a configured compiler; Go was absent. Installed both toolchains in ignored project caches. Rust installation reported a final rustup-location warning after successfully installing the compiler. Five Rust and four Go tests passed. Zod's four tests and TypeScript compilation passed.
- The gateway denied Sonnet with HTTP 403. Gemini 2.5 Flash-Lite completed an access check; its gateway limit is five requests per minute. Added shared pacing for new runners. Existing long-running processes retained their old imported code, so their failures are preserved and completed work is reused by explicit follow-up runs.
- Local Qwen3-0.6B generated four candidates for 40 official IFEval prompts and 20 authored creative prompts. First-candidate strict success was 21/40; Jev-selected success was 23/40; the best-of-four oracle was 30/40. Creative writing has no claimed human preference score. Three continuation-steering examples and a finite phrase-chain poem also ran.
- Browser Qwen ONNX generation and WASM vision captioning both ran successfully. ONNX logged a CPU execution-provider fallback warning; Chrome could not cache one large model response. Generation still completed. Vite reloads initially interrupted worker downloads, so browser tests were rerun after source changes settled.
- The vision input is an original screenshot of this gallery. The captioner called it a collage of electronic devices; Jev assigned only 0.25 to sufficient evidence. Publish this as a composition smoke test with a perception error, not a vision benchmark.
- Deployed the Bun/Vite app and authenticated Node function at https://jev-experiments.vercel.app. The CLI could not attach the private GitHub repository, so deployment uses the local project directly. Production checks returned 401 without a token, 400 for malformed input, and 200 for an authorized greeting test. Secrets were passed through stdin and never printed. The live access token is in `.cache/live-access-token` with mode 0600.
- Browser inspection found a hidden-button CSS override and a playback label that did not reset; both were fixed. The mobile homepage fits a 390px viewport without horizontal overflow. A patch tool call rejected duplicate edits to one file before applying anything; the patch was combined and retried.

## Final integration and interpretation

- GEPA's installed reflection callback receives a string, not always a message list. Fixed the adapter and superseded the broken run. The corrected run reuses already frozen random, hill-climb, and OPRO validation searches, with no test-driven prompt changes.
- Exact-state navigation caching records cache hits and includes action history in the key. This accelerates repeated observations but means episodes share decisions. Added a test confirming identical actions and no new calls for an identical episode.
- Completed all 60 Gemini reference answers by retrying only missing records at the permitted rate. Strict IFEval reference success is 35/40. Local candidate generation and Jev selection stayed fixed.
- CLINC breakdown matters: Jev versus the trained baseline was 84.0% versus 89.67% in-scope, and 78.0% versus 13.0% out-of-scope. The chosen 25% OOS mixture drives Jev's aggregate win. JudgeBench order disagreement was 27.78% among pairs answered in both orders.
- Exported the original SmolLM2 adapter/head, 913,829 bytes, with an inference helper and model card. Reloaded probabilities matched a recorded held-out case within 4.77e-6. No base-model weights are included.
- Added sklearn-versus-browser parity checks, passing at 1e-12 tolerance on repeated tokens, Unicode, and empty input. Browser local inference works; its incorrect hot-drink prediction also illustrates the policy's limited accuracy rather than hiding the failure.
- All 25 mobile experiment routes rendered without JavaScript errors. The sweep found overflow in classification and judging probability panels; fixed grid minimum widths and wrapping. Ambiguous beverage journeys show a clarification form instead of a confirmation action.
- The papercut CLI declined logging because this repository has not opted in; no root log was created. Process inspection and stopping a stale run required narrowly scoped sandbox approval.
- Prepared the research report, annotated sources, and twenty further directions. Fixed the publication copy script to preserve prepared result files during Vercel builds, where the parent research directory is absent.

## Completed results and release checks

- Corrected GEPA completed its 250 classified-record ceiling and retained the unchanged prompt. On 50 held-out cases, unchanged, random, hill climbing, and GEPA each scored 86%; OPRO scored 84%. All final test requests answered.
- All 240 navigation episodes completed. Empty-room success: random 70%, visible BFS 100%, reactive Jev 0%, memory Jev 100%. DoorKey success: 6.7%, 100%, 46.7%, and 96.7%. Memory had one request failure. Resumption preserved 184 completed episodes and 321 successful cached decisions; the final run accumulated 419 distinct decisions and 3,886 cache hits.
- Navigation now schedules independent episodes with four workers and shares identical in-flight requests. Published replay observations are losslessly interned: 17,619,271 bytes became 2,102,824 bytes, with every frame retained. A round-trip test verifies the encoding.
- Final small composition reruns: search 5/5, verifier 20/20 repeated variants, routing 19/20 with one failed request, beverage 23/24 with one failed request. Earlier overload-dominated runs remain in history.
- Final local ledger: 4,868 API attempts; $0.0129548 in reported charges and $8.884375096 conservatively accounted against the $25 ceiling. Unknown-cost reservations are not claimed as billed charges. Production smoke calls are separate from this local ledger and reported zero cost.
- Python checks now comprise ten tests including publication round-trip and browser parity. TypeScript has four tests, Rust five, and Go four. Builds and type checks pass. The reloaded replica matches recorded probabilities. No configured secret appeared in the selected project files.
- Production anonymous, malformed-authorized, and valid-authorized API checks returned 401, 400, and 200. The final mobile classification view fits 390px; long latency-field names needed wrapping as well as grid sizing. Rust formatting required installing rustfmt into the ignored local toolchain cache.
- Final production deployment is `dpl_vEJqrww7pFSVGD9JZ1murjeZWd5u`, aliased to https://jev-experiments.vercel.app. All 22 underlying result records are complete and feed the 25 gallery views. The prepared commit contains 101 original project files totaling about 9.8 MB; both binary artifacts are below 2 MB.
