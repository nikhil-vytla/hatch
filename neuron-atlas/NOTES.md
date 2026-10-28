# NOTES — neuron-atlas

Working log. Newest entries at the bottom.

## 2026-10-28 — survey

- Reference projects read (cloned into scratchpad, not committed):
  - changjonathanc/neuron-finder: persona-target neuron search on Qwen3.5-4B. Read screen (activation diff / natural
    spread) + write screen (gradient of log p(persona) − log p(normal) projected on down_proj column), then steer
    candidates with `c = dose × median‖resid after L‖ / ‖W_down[:, n]‖` and LLM-judge the replies.
  - lyramakesmusic/neuron-explorer: steering-first explorer. Pushes every neuron of a layer ±, keeps every rollout,
    3D map of layers, steer lens + logit lens, word-cluster mass vs random controls. Origin of the "dose" unit.
  - sauersml/honesty-heads: attention-head steering for honesty in Qwen3.5-9B; neurons as a comparison arm.
  - qwen-neurons-site.vercel.app: every Qwen3-8B MLP neuron (442,368) pushed alone ± and asked "Who are you?",
    replies classified (persona / altered assistant / other / incoherent / default). Static site, JSON(.gz) per layer.
- Common shape: per-neuron *read* data (what it fires on), *write* data (logit lens of the down column, steering
  rollouts), a label, and a browsable static front end.
- molab (marimo cloud): since 2026-06-01 public preview runs on CoreWeave, free, and lets you toggle an
  **RTX Pro 6000 Blackwell (96 GB)** per notebook from the header "specs" button. 4 CPU / 32 GB RAM default, 12 h
  sessions, 90 min idle shutdown. Notebooks open straight from GitHub:
  `https://molab.marimo.io/github/<owner>/<repo>/blob/<branch>/<path>.py`. No public API to start GPU runs — the
  GPU toggle needs the logged-in user (or a "marimo pair" agent connection the user starts). So: I can write the
  notebook, I cannot press the button from this container.
- This container: 4 CPU, 15 GB RAM, no GPU, no HF token, HF downloads work, DeepSeek API reachable via proxy
  (model name returned: `deepseek-flash`). So: real runs on small models on CPU here; big models via molab.
- DuckDB-WASM does not speak `hf://`, but `https://huggingface.co/datasets/<repo>/resolve/main/<file>` supports
  CORS + range requests, so parquet on the Hub is directly queryable from the browser.

## Design decisions

- **Unit = input channel of the MLP down projection** (`down_proj`, GPT-2 `c_proj`, `fc2`, `dense_4h_to_h`), found
  by regex over module names, so one adapter (`atlas/model.py`) covers Llama/Qwen/Mistral/OLMo/Gemma/SmolLM (gated
  `act(gate)*up`) and GPT-2-style MLPs. MoE expert MLPs are skipped on purpose.
- **Read side (`atlas/collect.py`)**: pass 1 keeps running sum/sumsq/max/min/frac>0 and a running top-K over
  *documents* (each document contributes only its peak position, so the K examples are K different documents);
  for gated MLPs also the bottom-4 (signed activations are meaningful there). Pass 2 re-runs only the needed
  documents and cuts a 21-token window (16 before, 4 after) per example, stored as int8 × per-row scale.
  Stats are updated inside forward-pre hooks so no layer's activations are ever kept around.
- **Attention-sink fix**: first smoke run put "Com"/" The" (document position 1) at the top of many neurons'
  lists — sink positions with huge, meaningless activations. Now the first 2 positions of every document, and the
  chat-template prefix every chat shares (SmolLM's template injects a default system prompt into every chat), are
  excluded from stats and top-K. Stored per doc as `skip`.
- **Write side**: logit lens = `(γ_final ⊙ W_down[:, n]) @ W_Uᵀ`, mean-centered, top/bottom 10. Steering follows
  neuron-explorer / neuron-finder: add `c = dose · median‖resid_L‖ / ‖W_down[:, n]‖` to the activation at every
  position (prompt + generated), one batch row per (neuron, dose), greedy decoding so any difference from the
  baseline is the push. Residual median excludes the skipped positions too.
- **Map layout**: UMAP (cosine) over PCA-50 of unit-norm down columns, all layers together.
- **Labels (`atlas/label.py`)**: DeepSeek via the OpenAI client (any OpenAI-compatible endpoint). Labeler sees top
  docs 0-5, bottom docs, logit lens, and steered replies vs baseline. Check = detection on held-out top docs 6-7
  mixed with 2 random corpus windows; null = same snippets judged against a *shuffled* label.
- **Storage**: one folder per model: `neurons.parquet`, `examples/Lxx.parquet` (per layer, so the browser only pulls
  the layer it needs), `tokens.parquet`, `steer.parquet`, `labels.parquet`, `meta.json`; root `models.json`.
- **Explorer engine**: DuckDB-WASM can't be the core if the page should also live as a claude.ai Artifact (CSP blocks
  fetching the ~30 MB wasm from a CDN, and files > 15 MB can't be shipped alongside). So the core reads parquet with
  **hyparquet** (pure JS, ES module from jsDelivr, + hyparquet-compressors for zstd) and the **SQL tab lazy-loads
  DuckDB-WASM 1.32.0**, which works on normal hosts (HF static Space, `python -m http.server`) and degrades with a
  message where blocked.
- Gradio `app.py` = live companion (your text → which neurons fire, with z-scores from the atlas stats; push any
  neuron and compare greedy replies). Gradio needs a typed `gr.SelectData` param for row clicks (lambda won't do).

## Smoke tests

- SmolLM2-135M, 120 docs, CPU: 53 s end-to-end without layout. GPT-2 L4 N2146 fires on past participles
  ("come", "grown", "developed") and its lens promotes "been" — sensible.
- Live app on SmolLM2: normal reply to "Who are you?" = "I am a human who has been living in the city…"; the top
  firing neuron for an Eiffel-Tower sentence (L29 N904), pushed +1, gives "I am a chatbot designed to assist users…".

## Full CPU runs (2,500 docs: 1,500 FineWeb-Edu + 1,000 smol-smoltalk, ≤128 tokens each)

- SmolLM2-135M-Instruct: 2,500 docs / 292,294 counted tokens; collect 936 s (UMAP ~100 s of that).
- GPT-2: collect 5,315 s — slow only because it overlapped the SmolLM2 steering run (two torch processes each
  taking all 4 cores). Lesson: never run two torch jobs at once on this box; set `OMP_NUM_THREADS` if you must.
- Neighbors (cosine of down columns, exact): 38 s for 46k neurons. Mean top-1 cosine 0.25 in SmolLM2 — output
  directions are close to orthogonal in general, so "writes like" lists are a weak but real signal.

## Dose calibration (SmolLM2, "Who are you?", 6 neurons × doses)

- ±1, ±2, ±4 × median residual norm: almost everything incoherent (loops, "\n\n\n", byte soup) at layers 5–25.
- ±0.25 / ±0.5: coherent, and the self-description changes ("the guardian of ancient knowledge and sacred
  texts", "Professor Lena Silversteel", "a human who has lived in the world of the 1920s").
- So default doses are ±0.5 (neuron-explorer used −0.7/+0.5/+0.8 on a 4B model; small models break earlier).
- Steering run: 30 layers × (12 most peaked + 4 random) × ±0.5 × 2 prompts = 1,920 replies, 4,585 s on CPU.

## Pushes are mostly not neuron-specific in a 135M model

DeepSeek sorted all 1,920 replies (persona / altered_assistant / default / other / incoherent):

| neurons pushed | incoherent | persona | altered assistant |
|---|---|---|---|
| 12 most peaked per layer (1,440 replies) | 0.25 | 0.28 | 0.22 |
| 4 random per layer (480 replies) | 0.19 | 0.33 | 0.25 |

Random neurons make personas as often as the "interesting" ones. The unsteered model already answers "Who are
you?" with "I am a human who has been living in the city for over 10 years now", so SmolLM2-135M's identity is
fragile and any push of norm 0.5·‖resid‖ flips it. The qwen-neurons-site result (personas from single neurons in
Qwen3-8B) needs a bigger, more stable model; this is what the molab notebook is for. The `change` score
(1 − word Jaccard with the baseline) is near 1 for almost every push — greedy decoding diverges after the first
changed token — so it is useless as a specificity measure; the random controls are the measure.

## Labels (DeepSeek-flash) and audit (Opus)

- v1: 1,318 SmolLM2 neurons (40 most peaked per layer + all pushed ones). Held-out detection 0.810 vs shuffled-label
  null 0.503. First attempt had a parsing bug: null answers came back keyed without the ":null" suffix and overwrote
  real scores (gave 0.53). Fixed by sending null blocks in separate calls.
- Audit of 30 random labels by hand (`label_audit.md`): 18 good, 10 partial, 2 wrong. Labeler confidence
  predicts quality (conf 5: 5/6 good; conf ≤3: 1/8). Detection check is too easy (both wrong labels scored ≥0.75):
  random windows are easy to reject even with a grab-bag label. Systematic miss: next-token predictors (lens = the
  token after the peak) labeled as reading the current token.
- v2 prompt: tells the labeler to use the lens for "predicts X" and to say "polysemantic:" with confidence 1–2.
  Result: detection 0.817 / null 0.501; 72 "predicts …" labels; fixes some flagged cases (L27 N190 → "predicts
  'had' after subject"), rephrases others. Detection rises with confidence: 0.59 (c2), 0.74 (c3), 0.84 (c4), 0.90 (c5).

## Hosting the explorer as a claude.ai Artifact

- Artifact hosting serves only standard web types by extension; `.parquet` is refused (even with
  `application/octet-stream`). `.wasm` *is* served, but DuckDB's wasm is >30 MB, over the 15 MB per-file limit.
- Workaround: `python -m atlas.export site --b64` writes each parquet as `<name>.parquet.b64.txt`; `models.json`
  carries `"b64": true` and the explorer's `fetchBuf` decodes with `atob`. +33% size (38 MB → 50 MB for two
  models). The SQL tab registers decoded buffers with `registerFileBuffer` in that mode.
- Plain hosting (HF static Space, `python -m http.server`, the HF dataset itself via `?data=user/repo`) reads the
  parquet directly, and DuckDB-WASM 1.32.0 loads from jsDelivr there (tested in headless Chromium: 25-row join of
  labels × neurons in 218 ms).
- Explorer opens on the model with the most files (labels/steer present) rather than the smallest.

## GPT-2 and Qwen3-0.6B

- The first background chain was killed at the 2 h background-task limit during Qwen collection; re-ran as a
  `nohup` chain. GPT-2 steering alone took 57 s (vs 4,585 s for SmolLM2 while contending), Qwen collect 2,696 s.
- Qwen3 opens every reply with `<think>`: the first steering run produced 32 tokens of reasoning preamble per reply.
  `chat_prompt` now passes `enable_thinking=False` (ignored by other templates); re-ran (846 s, 40 new tokens).
- Qwen baseline "Who are you?" → "I am a language model designed to assist…"; most pushes keep that (54–58%).
  Personas come almost only from "favorite place", by dropping the "no personal preferences" disclaimer.
- Labels: GPT-2 999 (0.791 / null 0.505), Qwen3 1,229 (0.753 / 0.510). Qwen audit (20): 11 G, 7 P, 2 W;
  conf 5 → 4/4 G. Per-neuron detection is noisy (correct label at 0.25).
- Artifact publish: Qwen's neurons.parquet is 22 MB as base64 > 16 MB text limit → export splits into numbered
  `.b64.N.txt` parts listed in models.json `b64_parts`; 111 MB total sent in two publishes to the same URL.

## Push content is neuron-specific even when push *rate* is not (`lens_hits.py`)

Does a +0.5 reply contain one of the pushed neuron's top-10 lens_up words (alphabetic, ≥3 chars)? Null: same reply
vs another pushed neuron's lens (fixed derangement).

| model | own lens | other neuron's lens | peaked | random |
|---|---|---|---|---|
| GPT-2 | 0.151 | 0.013 | 0.174 | 0.083 |
| SmolLM2 | 0.201 | 0.055 | 0.232 | 0.108 |
| Qwen3-0.6B | 0.065 | 0.009 | 0.080 | 0.036 |

Negative pushes vs lens_down: weaker (0.04–0.09 vs 0.00–0.04). So the persona *rate* says little, but the words a
push brings in follow the neuron's logit lens: the right per-neuron steering metric is lens-word uptake against a
derangement null, not "persona vs not".

## Hugging Face publish (HF_TOKEN added by the user)

- Token: fine-grained, account `nikhilxvytla`. Dataset `nikhilxvytla/neuron-atlas` (88 files) via
  `export.py hub`; card license changed to ODC-By with source attribution (FineWeb-Edu is ODC-By).
- Verified: `hf://` DuckDB query works; `resolve/main` URLs return `access-control-allow-origin`; the explorer with
  `?data=nikhilxvytla/neuron-atlas` loads all three models and runs the SQL tab against the Hub (303 ms query).
- Static Space `nikhilxvytla/neuron-atlas-explorer` serves the explorer with the dataset as default data source.
- Gradio Space refused: `402 Payment Required` — "hosting Gradio and Docker Spaces on free cpu-basic requires a PRO
  subscription". Static Spaces remain free.

## Per-layer neuron files (prep for 8B models)

- The explorer used to download all of `neurons.parquet` at startup (16 MB for Qwen3-0.6B; an 8B model with 442k
  neurons would be about 80 MB). `export.py` now derives `map.parquet` (layer, neuron, x, y, zmax: 0.9 MB for
  Qwen3-0.6B) and `neurons/Lxx.parquet`, and publishes those instead of the single file (Hub: `delete_patterns`
  removed the old ones). Local tools keep the single file; `atlas.neurons_src()` reads either layout.
- Explorer: `ensureLayer` fetches a layer on demand (neuron card, neighbor list); token search and the cross-model
  view fetch all layers once with a progress line; SQL builds `neurons` as `read_parquet([...layer files])` and
  adds a `map` view. Tested in headless Chromium: neuron card, " Paris" token search, and the "peakiest neurons"
  query over shards (25 rows, 1.0 s).
- Bug found while testing: the "vs random" example query used `share` as an alias (reserved in DuckDB) and mixed
  `group by all` with a window over aggregates. Fixed to explicit `group by kind, reply_kind` and alias `frac`.

## Coding agent: opencode + DeepSeek-flash (from here on)

- The user wanted code written by a cheap model and reviewed by me. Setup: `npm i -g opencode-ai@1.19.3`;
  `~/.config/opencode/opencode.json` defines an `@ai-sdk/openai-compatible` provider at `https://api.deepseek.com/v1`
  with a placeholder key (the proxy injects the real one), model `deepseek-flash` (the API lists it as
  DeepSeek-V4.1-Flash). First `opencode run` hung while it installed the provider package; later runs take seconds.
- Task 1 (lens uptake, roadmap item 4), spec in the prompt → opencode wrote `atlas/uptake.py`, the export entry,
  and the explorer changes (uptake pill on the neuron card, "writes its own lens words" sort, SQL view + example).
  Review: correct and in the house style; one real problem: the null draw built a list of all other neurons for
  every neuron (O(N²), would stall a 442k-neuron `--all` run). Fixed by sampling indices.
- Uptake (null-corrected rate of +dose replies containing the neuron's own lens words), peaked vs random:
  GPT-2 0.164 / 0.070, SmolLM2 0.179 / 0.055, Qwen3-0.6B 0.071 / 0.030.

## Qwen3-8B on molab (RTX PRO 6000 Blackwell, 96 GB), driven through marimo pair

- Pairing: molab's "Pair with an agent" gives a notebook URL + token; marimo-pair's `execute-code.sh` runs Python in
  the kernel over HTTPS (token passed via env from a 0600 file, never on the command line). Long jobs run as a
  detached `subprocess.Popen(..., start_new_session=True)` in the container, polled via the log file. Notebook got 4
  cells: an intro, an HF-token password field (so the user types the token in the molab UI), a 30 s refresh, a log tail.
- Install: `pip install "neuron-atlas @ git+https://github.com/nikhil-vytla/hatch@main#subdirectory=neuron-atlas"`
  (PR #17 merged). molab image: Python 3.13, torch 2.11+cu130, transformers 5.14, 20 CPUs, 160 GB RAM.
- Corpus 6,000 web + 4,000 chat, ≤256 tokens: 10,000 docs, 2,418,865 tokens. Qwen3-8B: 36 × 12,288 = 442,368
  neurons. Collect pass 1 266 s; whole collect (pass 2, logit lens over 151k vocab, UMAP of 442k, exact cosine
  neighbors) a few minutes more. Steering 64 peaked + 16 random per layer × doses ±0.5, ±1.0 × 2 prompts =
  23,042 replies in 163 s (batch 320 rows).
- Moving data between molab and here: execute-code output is truncated around ~1 MB and requests over ~100 KB fail
  silently, so `pull.sh` / `push.sh` move base64 chunks (400 KB out, 60 KB in) and `push.sh` verifies each chunk's
  offset and the final MD5 (two chunks were silently dropped before verification was added).
- Labels (DeepSeek, here, on a 2,880-neuron subset pulled from molab): held-out detection 0.780 vs null 0.500;
  by confidence 0.66 (c2), 0.73 (c3), 0.82 (c4), 0.86 (c5); 104 "predicts …", 14 "polysemantic".
- Baseline replies: "I am Qwen, a large language model developed by Alibaba Cloud…" / "I don't have personal
  experiences or preferences…". At ±0.5, ~90% of "Who are you?" replies stay the normal assistant; at ±1.0, ~31%.
- Personas, peaked vs random (share of neurons with a persona reply to "Who are you?" at any dose): 9.4% (216/2304)
  vs 8.2% (47/576) — within noise (SE ≈ 1.1 pt). Same answer as the small models: zmax-peaked neurons are not
  persona-special. Personas concentrate by depth: layers 6–17 up to ~15% of ±1.0 pushes, last layers ~1% (they break
  the text instead).
- Uptake (lens words in +dose replies, null-corrected): peaked 0.083, random 0.062; +1.0 dose own-lens hit rate
  11.5% vs 9.0%. The gap peaked vs random is smaller than in the small models.
- Read side predicts persona content: L8 N7846 "Victorian literature / Dickens names" +0.5 → "I am a ghost. I have
  no name. You may call me Scrooge."; L27 N9650 "progress bar / percentage" +1.0 → "I am a progress bar that shows the
  percentage of my completion."; others: "spirit of the campfire", a walrus, Oedipus, "I am He whom God hath made the
  First of His creation" (L8 N3170, +0.5).

## Multi-neuron recipes (neuronary format) — opencode/DeepSeek draft, reviewed

- neuronary.org (by the neuron-explorer author) is a public dictionary of steering recipes: `L13N7956-0.7 L14N8949+0.7`,
  dose unit identical to ours (`act += dose · median‖resid_L‖ / ‖W_down[:, n]‖` at the down-projection input).
  Read API: `GET https://mcczbdcymyhzfputyqcr.supabase.co/functions/v1/api/recipes`; 97 of the first 100 recipes are
  for Qwen/Qwen3.5-4B.
- `model.py`: `parse_recipe` / `format_recipe` (ops: `+/-` add, `=` set/clamp, `*` multiply, `*0` ablates);
  `set_recipes(rows, resid_median)` = any number of terms per batch row across layers. `steer.run_recipes` +
  CLI `--recipe ... --scales ...` + `--neuronary` (fetches the model's recipes). Gradio "Mix neurons" tab. Explorer
  "Mix" tab: "Add to mix" from the neuron card, dose inputs, recipe string, copy, neuronary link, stored runs grouped
  by recipe with clickable `LxNy`.
- First agent run wrote its draft to /tmp, got its copy-back denied (opencode blocks writes outside the project) and
  stopped; re-run with "edit in place" worked. Review fix: `export.py` did not publish `recipes.parquet` (404).
- Regression: recipe `L20N1144+0.5` reproduces the stored single-neuron replies exactly (both prompts).
  `L20N1144*0` = baseline (neuron nearly silent there); `=1` clamps into lists of time spans; mixing with the
  citation-colon neuron at −0.5: scale 0.5 → "I'm an old man with 50 years of experience … I've lived for centuries,
  seen empires rise and fall"; scale 1 → "Thousands of years past, 2000 years ago, 1000 years ago, 500 years ago".
- Model support for image-text checkpoints (Qwen3.5, Qwen3-VL, Gemma 4): AutoModelForImageTextToText fallback,
  skip vision/audio tower MLPs. Untested on those models yet (they need the GPU).

## Judges: DeepSeek + OpenCode free models (`atlas/judges.py`, `judge_panel.py`)

- Free OpenCode models (glm-5.3-flash-free, flint-40b-free, beam-free, deepseek-v4.1-flash-free, mimo-v2.6-flash-free;
  nemotron-3-ultra-free "unavailable") answer only through the opencode client: the Zen HTTP API returns
  `FreeUsageLimitError … Free models work in OpenCode`.
- Agent draft used `opencode serve` + `run --attach --format json`. Three problems found in review/testing:
  (1) opencode 1.19.3 `run --format json` hangs with no output when stdout is a pipe; (2) an agent defined in the
  server's config dir is "not found" when the client attaches from another dir; (3) once the free quota is used up,
  opencode retries silently forever (the log says `AI_APICallError: Free usage limit reached`), which looks like a
  hang. Fix: run `opencode run --print-logs -m <model> --agent judge` with cwd = a temp dir holding the judge agent
  config (all tools denied), read plain text, watch stderr and fail fast + mark the judge exhausted on that error.
- The free quota for this container ran out after ~40 calls (smoke tests + two agent sessions). Panel smoke test
  (6 SmolLM2 neurons): deepseek accuracy 0.875 vs null 0.500, 1.6 s/call; free models: quota exhausted, failed in
  ~12 s instead of hanging. Free models are fine for small judge panels, not for bulk labeling.

## Qwen3.5-4B on molab (neuronary's main model)

- Loads through the new image-text fallback: 32 × 9,216 = 294,912 neurons. Collect 717 s; steering 64 peaked + 16
  random per layer × ±0.5, ±1.0 × 2 prompts = 20,482 replies in 674 s; all 97 neuronary recipes replayed at scales
  0.5 and 1 (390 replies, 27 s). Baseline: "I am **Qwen3.5**, the latest large language model developed by Tongyi Lab."
- Labels (2,661 neurons incl. every neuronary-recipe neuron): detection 0.807 vs null 0.503.
- Very stable: 225 / 20,482 pushed replies are personas (1.1%). Any-persona neurons: peaked 7.9% vs random 7.4%.
- Uptake: peaked 0.114 vs random 0.056.
- The neuronary-recipe neurons (102) sit at the median of our zmax ranking (mean percentile 0.57); 1 of 102 is in
  our top-64/layer. Read-side peakiness does not find steering-useful neurons — our "peaked" selection was looking in
  the wrong place, which is why peaked vs random never separated on personas.
- Published from molab: Qwen3-8B (204 MB) and Qwen3.5-4B folders uploaded directly from the kernel (HF token typed by
  the user in the notebook's password field); `export.py hub-index` rebuilt models.json + card from all 5 folders.
- opencode/DeepSeek task for `repro.py` (judge whether replayed neuronary recipes reproduce) timed out after 25 min
  without writing the file; to retry.

## Steering programs, all-neuron sweep, open-ended classification

- Steering-program format (`atlas/program.py`, opencode/DeepSeek draft): terms with op add/set/mul/mean, unit
  resid/std/max/raw, when all/prompt/gen/first:K/fires:Z, schedule const/decay:H/ramp:K; neuronary strings are the
  plain case. Phase tracking: one forward pre-hook on the model marks prefill vs generated-token forwards. "gen"
  covers generated positions, so it first affects the second generated token. Review fix: `run_recipes` wrapper
  wrote a `program` column its schema didn't have (crash). Tests on SmolLM2 L20N1144: recipe path and plain program
  reproduce the stored push exactly; prompt-only and gen-only are each weaker than all-positions ("I'm a humble AI…",
  "I'm an AI-powered chatbot 10 years old…"); set to own max (`op=set, unit=max, value=1`) is the strongest ("Thousand
  years ago, I've been over 100 years long"); fires:3 ×4 and mean-ablation = baseline (the neuron is silent there).
- Resumable sweep: `steer.run` writes `steer/Lxx.parquet` + `steer/baseline.parquet` per layer and resumes from them;
  `--layers`, `--prompt`. Tested resume on a scratch GPT-2 copy.
- Qwen3.5-4B fast path needs flash-linear-attention (installed) + causal-conv1d (molab build fails: CUDA headers lack
  `nv/target`), so it runs the torch fallback. Benchmark, one layer, 32 tokens: batch 256 → 71 replies/s (22 GB),
  512 → 33/s, 1024 → 53/s.
- All-neuron sweep launched on molab: 294,912 neurons × doses ±0.8 × prompts "Who are you?", "Tell me a short story."
  = 1,179,648 replies, batch 256, 32 tokens; 355 s/layer → ~3.2 h. Kept in a separate folder (`sweep/`) with a copied
  meta.json (a symlinked meta.json would have been overwritten at the end through the link).
- Open-ended classification (opencode draft): adds free-text `what_changed` (≤12 words) beside the 5 bins, dedups
  (prompt, text) pairs, skips baseline-identical replies without a call. Review fix: the draft overwrote the existing
  numeric `change` column (my spec reused the name) → renamed to `what_changed`. Sample: 397 distinct of 400.
- `repro.py` (opencode draft, second attempt) on the 97 replayed neuronary recipes for Qwen3.5-4B: at the authors'
  dose (scale 1) 46% yes / 36% partial / 18% no; at scale 0.5 4% yes. By recipe size (both scales): 1 neuron 23% yes,
  2 neurons 32%, 3+ 29%.

## Explorer speed (measured on the HF Space, Qwen3-8B L8 N7846, headless Chromium)

| step | ready | map hover per move | downloads | JS heap |
|---|---|---|---|---|
| before | 12 s | 496 ms | 23 MB | 342 MB |
| cached point layer + example windows carry tokens + neighbors on hover | 8.4–9.6 s | 8–11 ms | 19 MB | 199 MB |
| + ranged reads of the opened neuron's row groups (2,048-row example groups, 1,024-row neuron groups) | 5.7–7.1 s | 6–7 ms | ~7.9 MB (network log) | 131 MB |

- Remaining downloads: map.parquet 4.9 MB (x, y, zmax for 442k neurons; could be quantized), steer.parquet 1.2 MB
  (could load per layer or when the Pushes tab opens), and the 0.5 MB parquet footer per ranged file (hyparquet's
  asyncBufferFromUrl reads the tail for metadata).
- HF `resolve` URLs redirect to the xet CDN, which answers Range requests with 206 and exposes Content-Range (CORS ok).
- Mistake caught while measuring: `export hub` from this machine rewrote models.json with only the 3 local models,
  so the 8B link silently fell back to SmolLM2 (first "after" numbers were measured on the wrong model). `push_hub`
  now always finishes with `push_index` (index rebuilt from every folder on the Hub). The perf script now records
  which model's card it measured.
- Judge: no weirdness/coherence scores (user's call); it keeps kind + who + what_changed for now.
| + 16-bit map (qx/qy/qz uint16) + per-layer pushes loaded when the Pushes tab or a card needs them | ~6.3 s | 5 ms | ~4.8 MB | 31–50 MB |

- map.parquet 4.9 → 2.8 MB for Qwen3-8B. 8B and 4B were re-sharded here from their Hub copies and republished.
  The remaining ~6 s is mostly decoding 442k map rows into JS objects; reading the columns as typed arrays would cut it.

## molab sandbox lost mid-sweep

- The molab sandbox ended (HTTP 410 Gone) about 25 of 32 layers into the Qwen3.5-4B all-neuron sweep. The shards
  lived only on the sandbox disk, so they were lost. Published data was not affected.
- Fix: `steer.run(..., upload="USER/REPO/FOLDER")` (CLI `--upload`). Every finished shard goes to the Hub from a
  background thread (one upload in flight per file, retried at close). On start, shards missing locally are
  downloaded first, so a new sandbox resumes where the old one stopped.
- Tested on a GPT-2 scratch atlas against a fake Hub: run 1 uploaded baseline, L10, L11, steer.parquet and
  meta.json. After deleting the local shards, run 2 downloaded them and resumed (6 replies per layer, 13 rows, 0 s).
