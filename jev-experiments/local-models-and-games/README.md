# Decision models on a Mac, and decisions in motion

This investigation compares local decision models with hosted Jev, trains a specialist in native MLX, exports it to Core ML, and adds two playable environments to the existing [Jev experiments app](https://jev-experiments.vercel.app). The app includes full benchmark cases, animated game replays, manual controls, visitor-key live play, and a research map for further experiments. Models and weights remain in an ignored local cache; the website serves recorded evidence and does not run MLX or Core ML in a browser.

## What we built

- An original MLX implementation of the published Laya encoder and decision head, checked numerically against its pinned PyTorch implementation.
- An MLX adaptation of [Eric Zhang's shared-prefix, first-token approach](https://github.com/ekzhang/openjev-sglang), running Qwen3 0.6B, Qwen3 4B Instruct 2507, and SmolLM2 360M Instruct. This ports the method, not SGLang's CUDA runtime or concurrent serving implementation.
- A second Qwen3 0.6B readout that scores full option descriptions with mean token log likelihood, informed by [daseinlabs/open-jev](https://github.com/daseinlabs/open-jev). It shares prefix and question caches but scores branches sequentially.
- Native MLX head training, a Core ML conversion script, measured inference, and parity checks. MLX trains; Core ML is an inference export target. We did not use or obtain proprietary Jev weights.
- Seeded Snake and an original Three.js drone game, Orbital rescue. Both expose the structured state and action probabilities. Jev and a deterministic greedy baseline play the same seeds.
- A benchmark shortlist and twelve concrete experiment proposals with a demo, protocol, metric, and limitation for each.
- Revised names and six subject categories. The old-to-new mapping is in `naming-review.json`; the terminology is in `CONTEXT.md`.

## Measured results

| Model / method | Teacher agreement | KL | Brier | Warm case median |
|---|---:|---:|---:|---:|
| Laya · original | 36.35% | 0.574 | 0.101 | Not compared |
| Laya · MLX fine-tune | 46.95% | 0.355 | 0.056 | 187 ms |
| Laya · Core ML export | 46.90% | 0.355 | 0.056 | 556 ms |
| Qwen3-0.6B · labels | 35.35% | 2.582 | 0.202 | 123 ms |
| Qwen3-4B-Instruct-2507 · labels | 54.05% | 5.317 | 0.191 | 672 ms |
| SmolLM2-360M-Instruct · labels | 25.45% | 0.483 | 0.083 | 108 ms |
| Qwen3-0.6B · option text | 33.60% | 0.537 | 0.089 | 283 ms |
| Jev · AI Gateway | 72.75% | 1.288 | 0.043 | Not compared |
| Uniform options | 27.65% | 0.444 | 0.072 | Not compared |
| Training label prior | 48.95% | 0.327 | 0.054 | Not compared |

The head fine-tune improved on its starting checkpoint but **did not beat the 48.95% training-label prior**, which does not read the state. That is the main limitation of this training run. Jev had the highest teacher agreement at 72.75%. The trained head is a port/training demonstration, not a model ready to fill private forms automatically.

The Core ML float16 export scored 46.90%, compared with MLX’s 46.95%. It changed 60 of 2,000 argmax decisions. The mean maximum probability difference per question was 0.00695, with a worst case of 0.14228. The first twelve parity checks had missed that worst-case drift. Precomputing float32 positional tables before tracing produced identical full-test predictions, so that hypothesis did not explain the drift; the final export must be treated as approximate. The original export comparison is preserved in `apple/coreml-initial-export.json`.

For games, both controllers completed Orbital rescue in 42, 24, and 30 turns for seeds 7, 19, and 42. Snake food totals were Jev 9/12/10 versus greedy 12/12/10; both crashed at turn 68 on seed 42. These examples do not show an advantage over the simple code baseline. Instruction changes and delayed consequences would be stronger next tests.

## Evaluation protocol

The benchmark is [LocalLLaMA/typed-decisions](https://huggingface.co/datasets/LocalLLaMA/typed-decisions), revision `ea9306458d6e9563628369a3d1e72e362fb381d2`, Apache-2.0. All 400 released test cases are included: 100 each for customer service, invoice processing, agent trace observability, and security incidents. Each case has five questions, giving 2,000 decisions per model. Original case IDs, states, instructions, option descriptions, teacher distributions, and model distributions are available in the app and the JSONL record.

The reference probabilities average sampled synthetic teacher judgments. Agreement with their most likely option is **not independently verified correctness**. The dataset does not identify an exact teacher checkpoint sufficiently to make a claim about matching a named frontier model. The teacher may be wrong, and its own uncertainty is preserved.

Training uses 960 cases from the released training partition, with 240 other training-partition cases reserved for validation. Splitting is by whole case and stratified by workflow. Only the decision head is trained, for two epochs and 600 steps, with soft-target cross-entropy, AdamW at 3e-5, weight decay 0.01, and gradient clipping at 1. The encoder is frozen. Checkpoint selection minimizes validation KL; temperature selection also uses only validation. The test set is evaluated after selection. This is supervised specialization, not RLCD or a general Jev replica.

The Laya baseline uses the published English root checkpoint and its per-type temperatures, with our explicit full-text packing. It is not Laya's separately released Typed Decisions specialist. Inputs are never silently truncated; the Laya limit is 768 tokens and eight options. Causal model inputs have an explicit 4,096-token limit.

Metrics include argmax teacher agreement, probability mass the teacher assigns to the selected option, KL divergence, normalized Brier error, ten-bin expected calibration error, and expected ordinal score MAE. Brier averages squared probability errors across the options within each question, then across questions. KL uses a 1e-12 floor. Equal argmax ties use the first option. Exact zeros from any model use the same KL floor; rounded API zeros can therefore incur a large KL penalty even when Brier remains low. Uniform probabilities and a per-workflow/question prior estimated only from the 960 training cases are included as code baselines.

Jev receives complete state and criteria for every question through Vercel AI Gateway. Boolean criteria, when provided by the dataset, are included in the instruction because the existing gateway wrapper accepts criteria only for choice and score questions. Recording initially batches eight cases, then four following transient provider overload. Calls that fail do not contribute labels; the recorder retains completed cases and retries unresolved cases.

## Timing and numerical checks

Hardware is an Apple M4 Max with 48 GiB of unified memory. Local model runs are sequential after training completes. Loading and warm-up are excluded. The measured interval covers one state and five questions. The first-token path tokenizes before timing, and Laya collates inputs before timing. Full-option scoring includes constructing and tokenizing each question/option branch inside its timed interval; its latency includes this additional work. Laya processes five independent padded rows. Causal models reuse the state prefix across five sequential question branches. These are distinct architectures doing the same decision workload.

The initial low-precision Qwen run failed cache parity at a 0.25 raw-logit difference. Floating activations and quantization scales now use float32; packed 4-bit weights remain packed. This choice trades some speed for numerical consistency. It is disclosed rather than quietly loosening the parity tolerance. SmolLM2 and Laya use float32 weights. Published GPU-server numbers from other projects are not mixed into our latency table.

Core ML timings use a different workload: one question at a fixed padded shape of 768 tokens and eight option slots. They are shown separately. `CPU_ONLY` and `ALL` are measured through real `MLModel.predict` calls; `ALL` lets Core ML schedule compute and does not establish Neural Engine placement. Core ML parity checks compare complete probability distributions and argmax choices against MLX.

The native Laya port matched the pinned PyTorch model on mixed question batches with a maximum absolute logit error of 0.0000176. Cache verification also checks reversed question order across each workflow so one branch cannot contaminate another.

## Games

Snake uses a 10×10 board, relative left/straight/right moves, seeded food, and a 90-turn horizon. Orbital rescue uses a bounded three-dimensional grid, three collectible cores, five stationary hazards, three hull points, and a 70-turn oxygen limit. After collecting the cores, the drone must return to the beacon. Three seeds, 7, 19, and 42, are recorded for each controller in each game.

The game engine supplies immediate action consequences and distances. Jev selects among those actions. This is structured-state control with code-computed previews, not visual game playing or a claim that Jev learned the physics. The code baseline minimizes immediate distance with a collision penalty; it is deliberately transparent, not an optimal planner. Valid game losses and timeouts remain in the comparison. Provider outages are recording interruptions and are retried.

Watch mode animates recorded decisions on a fixed playback clock. Network request times remain visible separately, so the animation is not presented as real-time API throughput. Manual mode needs no key. Live mode uses only the visitor's in-memory key through the existing gateway path. The site never substitutes an owner key.

## Sources and further work

The corrected [sgnt.ai post](https://sgnt.ai/p/jev/) prompted the comparison between label logits, option likelihood, and a learned scorer. We checked its linked implementations directly. Its proposed account of Jev's private architecture is speculation, not an established fact. [SemIf](https://github.com/TheoLeeCJ/SemIf), formerly TheoLeeCJ/openjev, already has an MLX path, and daseinlabs/open-jev also runs on Apple silicon. This investigation does not claim to be the first local implementation.

TypeSafe's [Doom demonstration](https://typesafe.ai/blog/introducing-system-one-models-and-jev) uses structured game information and a code/model combination. That informed the games here. The app's research map links original sources for BoolQ, ANLI, PAWS, SciFact, MASSIVE, WildGuardMix, AgentDojo, and Typed Decisions. Only Typed Decisions is run in this investigation; the others remain proposals. RewardBench 2 remains a separate existing experiment.

The most useful next local-model experiment is validation-controlled adaptation of the causal model, paired with option-order and paraphrase perturbations. For the paste companion, measure field-level precision and abstention on an independent authorized form dataset before allowing automatic entry. A local inference mode must prove that clipboard text never leaves the device and must never silently fall back to a cloud model.

## Reproduce

Run from `jev-experiments`. Python 3.13, Bun 1.3.14, MLX/MLX-LM, PyTorch, Transformers, safetensors, NumPy, PyArrow, huggingface-hub, and coremltools are required. Exact observed versions are in `apple/environment.json` and direct dependency pins are in `apple/requirements.txt`. The Core ML converter includes two narrow compatibility handlers for padding-mask ones and NumPy scalar integer conversion. Core ML prediction requires macOS; the native MLX runs require Apple silicon.

```sh
# Download only into ignored .cache. Keep the manifest's model revisions.
.venv/bin/python local-models-and-games/apple/prepare.py
.venv/bin/python local-models-and-games/apple/prepare_open.py

# Reference code is used for verification and Core ML conversion only.
git clone https://github.com/NandhaKishorM/laya .cache/laya-research
git -C .cache/laya-research checkout 42626c348753fbb17572a813127df2278a1ec527

.venv/bin/python local-models-and-games/apple/check_port.py
.venv/bin/python local-models-and-games/apple/train.py
.venv/bin/python local-models-and-games/apple/benchmark_open.py
.venv/bin/python local-models-and-games/apple/benchmark_laya.py
.venv/bin/python local-models-and-games/apple/check_caches.py
.venv/bin/python local-models-and-games/apple/export_coreml.py
.venv/bin/python local-models-and-games/apple/benchmark_coreml.py

# Uses your configured AI_GATEWAY_API_KEY; completed cases are resumable.
bun local-models-and-games/apple/record_jev.ts
bun local-models-and-games/arcade/record.ts
.venv/bin/python local-models-and-games/apple/aggregate.py
bun local-models-and-games/publish.ts
bun local-models-and-games/research.ts

cd experience-prototypes
bun install --frozen-lockfile
bun run build
bun test server ../local-models-and-games/arcade/engine.test.ts
bun run start
```

To rerun a local benchmark after changing its method, remove only its named `*-results.json` cache file. The script resumes existing completed model runs; it must not silently combine outputs from different prompts or precision settings. Trained weights, downloaded repositories, Core ML packages, and intermediate raw JSON remain ignored. The committed JSONL reconstructs ordinary JSON for the app during the build.

## Verification and publication

`bun run build` and 23 Bun tests pass, including all 400-case prediction matrices, deterministic replay integrity, train/validation/test separation, and existing caller-key isolation checks. Three analytic Python metric checks pass. The changed source and full production bundle were scanned for the configured recording key with no match. Representative business/security text was read and all 400 cases received the documented lexical content triage; see `apple/content-review.json` for the limits of that review.

Desktop, dark mode, and 390px layouts were checked in a real browser. Snake supports buttons and focused arrow-key controls. Recorded episodes play without a key; live controls prompt for the visitor's own key. The 3D game is loaded lazily, and it displays an explanatory fallback when WebGL is unavailable. Research filters, model/workflow selection, and full-case text inspection were checked.

The app remains in Vercel's existing `jev-experiments` project, with Root Directory `jev-experiments/experience-prototypes` and outside-root source access enabled. This branch stacks on the unmerged RewardBench 2 PR #55. No model weights, downloaded repositories, Python environment, or local API credentials are included in the commit.
