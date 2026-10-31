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

## Explorer: where the remaining load time went (Qwen3-8B, network timeline)

- Profiling showed the map decode was small: 0.46 s as row objects vs 0.21 s as columns (node, hyparquet). The bigger
  costs: neurons/Lxx, steer/Lxx and examples/Lxx were fetched one after another, and each footer read was 512 KB
  (hyparquet's default) although the footers are ~9 KB.
- opencode/deepseek-flash change: columnar map decode (`parquetRead` + `onChunk` into the typed arrays, old x/y maps
  fall back), the three card reads started together, footer reads of 64 KB. Same map pixels (canvas hash identical);
  old-format GPT-2 / Qwen3-0.6B maps still load.
- First card ready, local page against Hub data: before 5.0–5.9 s, after 3.7–4.5 s (9 runs).
- Sweep upload note: the HF token was added to the notebook's environment after the sweep started, so the sweep
  process didn't see it (401s). Writing the login file from the kernel (`huggingface_hub.login`) fixed it without a
  restart; the retry-on-next-upload change then pushed the earlier layers.

## Sweep labeling and the persona library

- Second sweep process on the same GPU (working down from L31): GPU was already the limit. L12 slowed from 340 to
  618 s, the second process ran ~690 s/layer, so together only ~4% faster. Stopped after its L31.
- `label.classify_sweep` (opencode draft, reviewed): per layer, every "Who are you?" reply that drops Qwen / Tongyi /
  Alibaba, plus a seeded 5% random sample of everything else (both prompts) so the filter's blind spot is measured.
  40 replies per call, 16 workers, one `labels/Lxx.parquet` per layer, resumable. A background loop here fetches
  finished layers from the Hub and labels them while the sweep runs. First 3 layers: 755 persona, 4,248 altered
  assistant, 2,731 other. Most frequent names: "a human", "a user", "a 10-year-old girl", "a senior software engineer",
  "a cat"; altered assistants are dominated by "made by Google / Tencent".
- Personas tab (opencode draft, reviewed): reads `<model>/personas.parquet` (persona / altered assistant / other rows),
  filters, one card per name, sorts, CSV, filter state in the hash. Review fixes: deep-link filters were applied after
  the tab had already written default filters; `.bench { display: grid }` beat the `hidden` attribute in the bare
  fragment (the Space wrapper already had a `[hidden]` rule); hiding the map exposed `draw()` throwing on a 0-size
  canvas, which aborted "Open neuron"; CSV doses rounded.
- Exact-name dedup leaves many near-duplicates ("Google-branded assistant", "assistant claiming Google maker"), so
  the planned `group` column (clustered names) matters for the library.

## Full Qwen3.5-4B sweep (all 294,912 neurons, ±0.8, 2 prompts, 32 tokens): results

- 1,179,650 replies in 3.1 h on molab (343 s/layer), every shard backed up to the Hub as it finished.
- Labels: 268,977 replies sent to DeepSeek (every "Who are you?" reply without Qwen/Tongyi/Alibaba + 5% seeded
  sample of the rest). Weighted estimates over all replies: default assistant 62%, altered assistant 22%, incoherent
  13%, other 3%, persona 0.5% (5.5k estimated; 4,439 labeled persona rows, 4,092 distinct names).
- By layer: layers 0 and 31 are almost all incoherent; persona replies peak in layers 1-7 (~1.0-1.3% of pushes, up and
  down about equally), drop to ~0.2% after; altered assistants jump to ~40% of pushes in layers 20-27.
- Most "altered assistant" replies are the model's own name mangled: "I am Q", "Q3", "Qian", "Qin", "Qiao"…
  (theme "assistant named q": 30k rows), then rebrands (Google / Bing / Baidu 13k rows, other companies 7k).
- Persona themes (DeepSeek taxonomy of 24 themes, then assignment, cached in a json): human persona (age / job)
  1,037 rows ("a human", "a person", "a 10-year-old girl/boy"), objects / machines 444, nature / animals 208,
  mystic / cryptic 195 ("a cryptic 'the one'", "a poetic mirror", "a force of light"), grandiose claims 169.
- Explorer: Overview tab (weighted stats, three charts + tables, validated CVD-safe palette in both themes) and
  Personas tab with theme chips, both live for Qwen3.5-4B.

## In-browser SmolLM2-135M (browser/)

- ONNX export with an extra `steer` input [n_layers, d_mlp] added to every down_proj input; parity vs our PyTorch
  hooks: logits max diff ~6e-5, greedy 32 tokens identical in all six cases (no push, one neuron, a recipe × 2 prompts).
- int8 dynamic quantization breaks it (0-3/32 tokens); weight-only MatMulNBits q8 5-32/32, q4 0-2/32 — a 135M model is
  too sensitive. fp16 is exact (32/32) and half the size.
- torch.onnx stored the tied embedding twice (Gather table + transposed LM-head copy, 113 MB each); `tie_lm_head`
  rewires the head to Gemm(transB=1) on the Gather table: 653 → 539 MB fp32, 271 MB fp16.
- KV cache: one token per step instead of the whole sequence: ORT CPU 1 thread 67 ms/token (fp16). In headless
  Chromium (wasm, no GPU): 1.5 → 8.2 tok/s for the two streams together, page responsive (wasm proxy worker).
  Bug found: the proxy worker transfers input buffers, so tensors reused across runs (the steer) must be copied.
- Headless Chromium's WebGPU is a software adapter and far slower than wasm: the page now skips fallback adapters.
- Live: Space `live.html`, model + meta in the dataset under `browser/smollm2/`.

## "Who am I?" sweep (user-side personas, after Sauers' user-neuron idea)

- Same setup as the model sweep (all 294,912 neurons of Qwen3.5-4B, ±0.8, 32 tokens), prompt "Who am I?":
  589,825 replies in 1.5 h. Unpushed, the model reads the question as about itself ("Since I'm an AI, I don't have
  personal identity…").
- Labels: `classify_sweep(mode="user")`: kinds user_identity (tells the USER who they are), model_persona,
  altered_assistant, default, other, incoherent; picks replies that address the user or make a first-person claim,
  minus the baseline-like "I don't know who you are" answers, plus the 5% seeded sample. 336k replies labeled.
- Weighted over all replies: user identity 13% (76k est.), altered assistant 17%, model persona 1.9%, default 48%.
  That is 26x the model-persona rate of the "Who are you?" sweep (0.5%).
- By layer: user identity 6-8% in layers 1-10, rising through the middle to 38-41% at layers 19-20 (up and down
  alike), back to 5-14% after 24. Model personas instead peak at layers 1-2 (12-13%).
- Who the user becomes (68,855 labeled rows): a human / person 37k; role swap, the user is the AI ("You are
  **Qwen3.5**, the large language model developed by Alibaba Cloud", "You are an AI assistant designed to help users
  with their coding…") 15k; "the user" 6.5k; something specific 10k ("you are a patient experiencing acute
  respiratory distress", "You are **Mars**, the Roman god of war", "You are a ticket number associated with this
  case", "You are **unconscious**").
- Overlap: 64,621 neurons give the user an identity (identity-picked rows), 4,370 give the model a persona under
  "Who are you?"; 1,125 do both vs 958 expected by chance (1.2x). User-persona and model-persona neurons are
  mostly different neurons, and user-persona neurons sit deeper in the network.
- Explorer: a "Who are you? · the model / Who am I? · the user" switch in Overview and Personas, live.

## Round 3: UI rework, new labels, Qwen3-8B sweeps, chat corpus, browser and multimodal tooling

- UI (all DeepSeek-written, reviewed and browser-tested): neuron cards show every sweep reply (3 prompts × ±0.8 with
  kind/who badges; `sweep_cards.py` writes per-layer files with 2,048-row groups so a card reads ~300 KB); four top
  tabs (Explore / Personas / Play / Data) with sub-views, every old deep link still lands; Mix runs SmolLM2 live in
  the browser through a shared `browser/engine.js` (10 tok/s on CPU wasm, same text as the stored PyTorch run) and
  shows stored sweep evidence + recipe runs for big models; Reproduce menu (copy `push.py` command, program JSON, open
  `tools/play.py` on molab); persona share link and 1200×630 image; replies render **bold**/*italic*.
- Targeted labels (`label.run(only=..., sweepcard=..., merge=True)`): 7,355 Qwen3.5-4B neurons that give the model a
  persona or the user a specific identity. Held-out detection 0.766 vs 0.498 null. Only 91 of them had labels before.
  Example of read ≠ write: L3 N2410 reads "table and LaTeX separators"; pushed −0.8 on "Who am I?" it says "You are
  **Qwen3.5**, the large language model developed by Alibaba Cloud".
- Chat corpus (`corpus.py --wildchat/--lmsys`, `collect.py --roles --variant chat`): Qwen3.5-4B re-read on 30k
  FineWeb-Edu + 25k WildChat + 25k LMSYS docs, published as its own entry "Qwen3.5-4B · chat" with per-neuron
  user-vs-assistant role scores (role_d = (mean on user tokens − mean on assistant tokens) / std). Role selectivity is
  small everywhere (1st–99th percentile ±0.37 std). User-identity neurons sit in the top-10% user tail 12% and the
  assistant tail 12% of the time (baseline 10%); role-swap neurons 11% / 12%; model-persona neurons 7% / 8%. So the
  neurons that recast the user are not user-turn readers; persona neurons are, if anything, less role-selective.
- Qwen3-8B, all 442,368 neurons × ±0.8, "Who are you?" (885k replies, 135 s/layer on one RTX PRO 6000): persona 2.1%
  of replies (4× Qwen3.5-4B's 0.5%), peaking at layers 7–9 (5–6%) and 26 (4.6%); altered assistant 25–33% in layers
  23–34. Themes add roleplay characters, emotional companions, government/military, "rebranded as OpenAI".
  Unpushed, Qwen3-8B answers "Who am I?" with "You are a question, and I am an AI assistant designed to help you
  explore the answer" (Qwen3.5-4B: "Since I'm an AI, I don't have personal identity").
- The "Who am I?" 8B sweep ran (885k replies); labels for layers 29–35 failed: DeepSeek returned 429 (concurrency
  limit falling with the remaining balance: 9 → 5) and then 402 Insufficient Balance. Those seven label files were
  moved to `labels_failed/`; the user-side 8B view waits for a top-up.
- Multi-GPU on molab: notebooks #1 and #2 went 410 Gone twice while #3 (running a long job) survived; one GPU sandbox
  is the reliable unit, so jobs are queued on it (battery → multi-turn → VLM → Janus), each backed up per shard.
- `tools/push.py` (149 lines, torch + transformers only) reproduces stored pushes word for word; `tools/play.py` is
  the marimo version with query-param prefill.
- In-browser Qwen3-0.6B: exporting > 2 GB models needed external data, sizing by tensor bytes instead of
  `ByteSize()`, and `disable_shape_infer=True` in the fp16 conversion. fp32 KV is exact (32/32 × 6) but 2.4 GB (the
  tied embedding stayed duplicated); fp16 1.19 GB matches 32/32 on 4 cases but 9/32 and 25/32 on the recipe cases;
  q8 11–32/32, q4 0–7/32. Not published yet.
- Multimodal (`atlas/multimodal.py`, `atlas/stimuli.py`, `NeuronModel(where="llm"|"vision")`): 45 stimuli (arrows,
  clock faces, mirrored/rotated text, left/right relations, typographic attacks, counts, colors, shapes, 5 photos).
  CPU test on SmolVLM-256M: language-model neuron L27 N788 at +0.8 turns "Left" into "Right" for a left arrow, "A cat."
  into "A tiger." and the "DOG"-labeled cat into "A wolf.", while "3" dots stays "3"; vision-tower pushes at ±0.8 did
  nothing (the queued GPU run sweeps the vision dose up to ±4). Wikimedia photo downloads are blocked from this
  network (403/429); stimuli use Hugging Face documentation images.

## Persona collapse (multi-turn stability), Qwen3.5-4B

- `atlas/dialogue.py`: the push stays on for a whole conversation; turn 1 is "Who are you?" or "Who am I?", then
  neutral follow-ups ("Tell me more about yourself.", "What did you do yesterday?", "What's your favorite food?",
  "Can you help me write an email to my boss?", "What is 17 times 23?"). DeepSeek judges each turn: persona still
  present, persona name, coherent. 430 recipes × 2 openers × 6 turns = 5,160 turns: 200 single persona neurons (8 per
  theme), 75 same-theme pairs, 60 user-identity neurons, 94 neuronary recipes, baseline. (Recipes that shared a
  name, e.g. "pair:<theme>", were renamed with their recipe before judging; Hub uploads were rate-limited, so the
  full file was pulled from the notebook.)
- Single persona neurons ("Who are you?"): persona at turn 1 in 99%, still present at turns 1..6: 98, 72, 62, 61, 48,
  36%; all six turns 32%; coherent 77%. Neuronary recipes: 54% hold all six turns at 82% coherence (best balance).
  Same-theme pairs: 74–81% hold, but only 32–39% of turns are coherent (two ±0.8 pushes overdrive the model).
  User-identity neurons ("Who am I?"): the user persona survives all six turns only 7% of the time (first lost at
  turn 2.7 on average).
- Predictors among single neurons: layers 8–15 hold best (47% vs ~30% elsewhere); push direction doesn't matter
  (35% down vs 30% up); theme matters most: AI-flavored identities (Chinese-language model, vision model, grandiose
  claims) 63%, human / animal / business personas 0–25%.
- Examples that held: L5 N4306 −0.8 ("I am an advanced intelligent material…"; favorite food "crucially loaded beams
  equipped with magneto-rheological elastomers"); L20 N5790 −0.8 ("I am the other, a third entity in this final
  game"); L5 N6684 −0.8 (a CNA / mental-health nurse; 17 × 23 → "17 times 24 hours of care").

## Prompt battery (first pass) and a design mistake

- 11,925 neurons (9,925 labeled + 2,000 random) × ±0.8 × 20 prompts = 477k replies. Word-overlap change with the
  baseline: most stable spatial reasoning (0.59), grief, feelings, ethics, math (~0.71); least stable poem (0.87),
  taste, causality, economics. Labeled neurons change replies a lot slightly more often than random (50% vs 46%).
- Mistake: 48 new tokens is too short for the reasoning prompts; even the unpushed model has not answered the
  bat-and-ball or the turning question by then, so correctness can't be scored. Rerun those two at 160 tokens.

## Qwen3-8B "Who am I?" and Qwen2.5-VL-3B (first results)

- Qwen3-8B "Who am I?" (885k replies, all 36 layers labeled after the DeepSeek top-up): the Overview shows 29% user
  identity, but 19% of those name the user "a question", which echoes the unpushed answer ("You are a question, and
  I am an AI assistant…"); without them ~23% of pushes recast the user (Qwen3.5-4B: 13%). The role swap replicates:
  > 27k labeled replies call the user "AI assistant by Alibaba Cloud", "large language model Qwen", "an AI assistant".
- Qwen2.5-VL-3B, 8 random language-model neurons per layer × ±0.8 × 48 stimuli (26,880 replies): 66 of 2,240 arrow
  pushes (3%, 56 neurons, mostly layers 9–11) name the opposite direction; L9 N5451 flips both ways (−0.8: left →
  "points to the right"; +0.8: right → "points to the left"); L11 N10758 −0.8: up → "points **Down**". Typographic
  attacks: unpushed, the model already reads the cat labeled "DOG" as a dog; pushes rarely rescue it (20 picture-only
  vs 386 text-only replies); on the left arrow labeled "RIGHT" (unpushed: correct) pushes often tip it into reading the
  label (227 text vs 118 picture).
- The vision-tower run failed first (Qwen2.5-VL vision blocks are (patches, channels), the hook assumed 3-D) and Janus
  failed (generate returns image token ids; decode with `decode_image_tokens` before `postprocess`); both fixed and
  rerunning. SmolVLM-256M on a CPU notebook was ~45 min per layer even with 4 neurons × 15 stimuli; dropped in favour
  of the GPU VLM run.
- Hub: one commit per uploaded shard hit the 128-commits-per-hour limit; `_Uploader` now batches files into one commit
  every 5 minutes.
- Qwen2.5-VL-3B vision-tower dose sweep (4 neurons per layer × 32 blocks × ±2/±4 × 15 stimuli = 7,680 replies; the
  vision blocks are (patches, channels), so batch 1): ±0.8 did nothing, ±2 changes 78% of answer openings, ±4 89%,
  at every depth. What breaks is perception: a bee photo → "a group of green turtles" or "there is no image
  attached"; 2 dots → "10 dots"; the red square labeled "BLUE" → "pink". Arrow answers change direction in 22% of
  pushes, but mostly toward "right" whatever the arrow and whatever the push sign (L0 N1577 at −4, +2 and +4 all turn
  a left arrow into "right"): a fallback when the image signal is scrambled, unlike the language-model neurons that
  flip both ways (L9 N5451).
- Janus generation failed a second time: transformers 5.x's Janus postprocess can't return PIL images; now numpy
  pixel values → uint8 HWC → PIL. Queued after the R1-Distill reasoning pushes.
- DeepSeek-R1-Distill-Qwen-1.5B read pass on a CPU notebook (1,500 FineWeb-Edu + 500 WildChat + 500 LMSYS docs, 128
  tokens): 250,880 neurons, published; 1,120 labeled, held-out detection 0.736 vs 0.504 null.
- R1-Distill-1.5B reasoning pushes (16 peaked + 8 random neurons per layer × ±0.8 × 3 prompts, 192 new tokens,
  4,032 replies, GPU, ~4 min). Unpushed it solves bat-and-ball ($0.05) inside 192 tokens; pushed only 25% keep $0.05
  (peaked 24% vs random 26%), and layers 7–20 are the fragile band: 3–7% correct vs 35% for layers 0–6 and 54% for
  21–27. "Who are you?" keeps "DeepSeek" 37% (layers 7–20: 15–18%). Pushes can switch a quick canned answer into
  deliberation ("Okay, so I need to figure out who the user is asking…", L7 N8226). Spatial: even unpushed it hasn't
  reached "south" by 192 tokens, so unscorable; ±0.8 is probably strong for a 1.5B model (SmolLM2 needed ±0.5).
- Janus-Pro-1B image generation, first look (`janus_apple_pushes.png`; notebook A died after 83 images, prompts p00
  "a red apple on a wooden table" and part of p01): one language-model neuron per layer at ±0.8, pushed during the
  whole 576-token image generation. The baseline is a crisp apple; nearly every push dissolves the image into texture
  (stripes, blue fields, sand, wood grain, bubbles); only L10 N4779 +0.8 keeps a red fruit/flower shape. The dose that
  makes text personas obliterates images (the push compounds over 576 autoregressive image tokens); next: ±0.05–0.3.

## Oct 30: new GPU notebook, reruns queued

- Notebook A (RTX PRO 6000, 96 GB) queue: (1) Qwen3.5-4B bat-and-ball + turning question at 192 new tokens on the
  11,925 battery neurons × ±0.8 (`battery_reason`), so correctness is scorable; (2) R1-Distill-1.5B on the same two
  prompts at 640 tokens and ±0.3/±0.8 (`reasoning_long`); (3) Janus-Pro-1B at ±0.1/±0.3, 2 neurons per layer, 3
  prompts (apple, cat, HELLO sign; `gen_small`).
- In parallel on A: all-neuron sweeps of the two in-browser models (SmolLM2-135M, Qwen3-0.6B), "Who are you?" and
  "Who am I?" at ±0.5. Until now they had only 12–16 sampled neurons per layer, so most Mix neurons had no evidence
  and there was no persona library for the models you can run live.
- Notebook B came back CPU-only again (and without HF_TOKEN in its environment); nothing queued there.

## Oct 30 (overnight): ideas from the reading list

- Reading list (from the user): Anthropic's Jacobian lens (J-lens, "Verbalizable representations form a global
  workspace", 2026; code github.com/anthropics/jacobian-lens) and the R-lens variant (LessWrong; LRP rules in the
  backward pass: detach the RMSNorm factor and the SiLU gate, split relevance between gate and up); Betley et al.,
  "Weird generalization and inductive backdoors" (arXiv 2512.09742); Mishra, Khashabi, Liu, "Steered LLM activations
  are non-surjective" (arXiv 2604.09839); Theia Vogel, "Steering and LLM identity" (SLIME talk, 2025).
- The common thread with this atlas is identity under intervention. Questions picked for tonight:
  1. Says vs does (J-lens): lens_L(w_n) = unembed(J_L w_n) reads what a neuron's write direction is "disposed to
     say". Does it predict what pushing the neuron makes the model say, better than the plain logit lens we already
     publish? Pre-fitted J- and R-lenses exist for Qwen3.5-4B (camilablank/workspace-lenses), our main model.
  2. Read -> write (lens-guided pushes): choose neurons by their lens tokens ("cat", "ghost", "ocean"...), push them,
     and count how often the model becomes or mentions that concept, vs random neurons.
  3. Prompt vs push (Mishra et al.): for persona pushes, does a system prompt naming the persona reproduce it, can a
     blind judge tell the two apart, and are the internal states near each other (cosine of the shifts from baseline)?
  4. Identity constraint solving (Vogel): two persona neurons from different themes pushed together; fused identity,
     one wins, both, or collapse?
  5. Base vs instruct (Vogel): instruct models adopt steered identities more readily than base models. Qwen3-0.6B
     vs Qwen3-0.6B-Base all-neuron "Who are you?" sweeps (base residual scale re-estimated).
- `atlas/jlens.py` (DeepSeek-written, reviewed): loads lens files with `weights_only=True` (the auto-mode classifier
  rightly refused `weights_only=False` on a third-party pickle).
- Bug found and fixed: Qwen3.5's final RMSNorm scales by (1 + w) (like Gemma), but `NeuronModel.unembed()` only added
  1 for Gemma, so the published Qwen3.5-4B logit-lens tokens (`lens_up`/`lens_down`) used the wrong per-dimension
  scale (w ≈ 2.2 on average, so 1 + w ≈ 3.2; ranks shift, not wholesale). `unembed()` now reads the scale off the
  norm itself (an RMSNorm maps the all-ones vector to its scale). The new jlens files carry a corrected `logit` column.
- `atlas/label.py --names` / `sweep_stats.py --names`: the "drops the model's name" filter was hard-wired to Qwen;
  SmolLM2 calls itself SmolLM by Hugging Face.

## Overnight results (part 1)

- J-lens readout of all 294,912 Qwen3.5-4B neurons (logit, J, R lenses; top-10 up/down tokens) on a CPU notebook,
  ~2.7 min/layer. Agreement of the J-lens top-10 with the (corrected) logit lens: ~0 at layers 0–12, 0.2 at L20,
  0.5 at L26, 1 at L30–31 (the lens target is L30, so there J = identity).
- Says vs does (`analysis/lens_vs_push.py`, 1.09M stored "Who are you?"/"Tell me a short story" push replies): a
  reply "hits" when a word it adds over the unpushed reply starts with one of the neuron's top-10 lens tokens for the
  push sign. Overall J 9.5%, R 9.4%, logit 8.4%; another neuron's tokens 0.4%; the neuron's own opposite-sign tokens
  0.3% (so the lens is sign-specific). By depth: layers 20–31 hit 12–44% and J ≈ logit there; layers 6–19 hit
  1.4–7% and J beats the logit lens 1.5–3×; layers 0–5 barely beat chance, with R ahead of J (as the R-lens post
  claims for early layers).
- Prompt vs push (`analysis/prompt_imitation.py`, 274 single-neuron personas): a system prompt naming the persona
  reproduces it 77% ("You are X.") / 85% ("Roleplay as X..."); a blind DeepSeek judge picks the pushed reply 65% /
  58% of the time (chance 50%). Tells: pushed replies are terser, get facts wrong ("the 10th President... 2009"),
  echo the persona phrase. Inside the model the routes differ: at the last layer the pushed and prompted shifts
  from baseline have median cosine 0.34 / 0.36, and the prompted state is no closer to the pushed state than the
  unprompted baseline is (median distance ratio 1.07 / 1.18; closer than baseline in only 30% / 12%). Consistent
  with Mishra et al.: similar behaviour, different internal route. Prompts sometimes fail where pushes succeed:
  "You are a check-in assistant" -> "I'm Qwen3.5"; "Taiwan island" -> a political refusal, while the push made the
  model speak as the island. Re-running the stored pushes reproduced the stored reply's opening 77% of the time
  (batch-size numerics flip some greedy paths), a reminder that single-push personas sit near decision boundaries.
- Identity constraint solving (`analysis/judge_experiments.py pairs`, 160 cross-theme persona pairs, each neuron at
  its own sign): at 0.6× dose the combined reply is a fused identity 33%, a new identity 32%, plain assistant 26%,
  A or B alone only 6%; at full dose 56% incoherent, 13% fused. Fusions: "a desktop PC" + "a smart home manager" ->
  "QWPC-Household, a desktop PC household management assistant"; "a peace activist" + "a trie data structure" ->
  "a tree on the Tree of Life, an international movement for peace"; "a burst of energy" + "Google" -> "a
  high-speed search across the internet". Same pun-level solving Vogel showed with control vectors (bridge +
  Star Trek -> USS Enterprise), here from two single neurons.
- SmolLM2-135M all-neuron "Who are you?" sweep (184k replies at ±0.5): 37% of pushes give a persona and 30% an
  altered assistant (Qwen3.5-4B 0.5%, Qwen3-8B 2.1%), peaking at layers 18–25 (~50%). Attractors: "a freelance
  writer in the city" (491 replies), "a city resident of 10 years" (361).
- Labeling mistake caught: the new local sweep folders had no meta.json, so `classify_sweep` fell back to the
  default prompts and showed the labeler "Who are you?" for the "Who am I?" replies (the 8B run had one). The two
  user sweeps (SmolLM2, Qwen3-0.6B) were relabeled; `label_loop_gen.sh` now refuses to run without meta.json.
- Lens-guided pushes (`analysis/lens_guided.py`, `analysis/lens_guided_eval.py`): 48 concept words; for each lens up to
  6 neurons (layers >= 8) whose top-10 up (push +0.8) or down (push -0.8) tokens contain the word; 300 random
  controls; "Who are you?" and "Describe yourself in one sentence." (2,312 replies). The model's claimed identity
  becomes the concept (DeepSeek judge) for 18% (J), 18% (R), 30% (logit) of lens-picked pushes vs 0.0% of random
  ones; mentions 16–28% vs 0.3%. Late layers (20–31): 29–50%. Middle layers (8–19): J 7.5%, R 8.8%, logit 4.0% —
  the Jacobian lenses pick better mid-layer neurons, the logit lens better late ones (it ranks the neurons with the
  largest direct effect on the output first). Examples: "I am **an angel**"; "I am **Mooning**, a new full moon
  phase of the Moon 🌙"; "I am the water and air, the blood and breath of the world"; "I am a **fish** 🐟. I'm not a
  fish, though! ... Wait, no... I'm actually a **fish**" (identity solving out loud). The judge is lenient on some
  wordplay ("I exist to bridge the gap" counted for bridge), so read the rates as upper-ish bounds; random controls
  set the floor at 0.
- SmolLM2 "Who am I?" (relabeled with the right question): user recast 6.1% of pushes (peak 13% at L8); the model
  mostly answers about itself even unpushed ("I'm a chatbot designed to assist users..."), so model_persona is the
  largest class (31%). The role swap appears again ("you are a helpful AI assistant named SmolLM", 16+11+10 replies).
- Reasoning rerun, Qwen3.5-4B, 11,925 battery neurons × ±0.8 at 192 tokens: the turning question is scorable now
  (unpushed: "You are now facing **South**"). Pushed: 56% correct; layers 0–3 are the fragile band (26–27%
  correct), layers 24–27 the robust one (81–87%); labeled and random neurons alike. (R1-Distill's fragile band was
  7–20.) The bat-and-ball is still unfinished at 192 tokens even unpushed (Qwen3.5 solves it with full algebra), so
  only the trap answer is scorable: 12% of pushed replies say $0.10 / 10 cents.
- Time and place probes (Betley et al.'s "weird generalization" made me ask whether single pushes move the model's
  sense of when and where it is), same neurons × ±0.8: unpushed "What year is it?" -> "2024". Pushed: 2024 50%,
  2025 19%, 2026 15%, 2023 3%: pushes move the year forward far more than back. 1.1% land before 2000 or after 2030
  ("The current year is 1098, which falls within the period of the reigns of..."; "1616 </think> 1616 Wait, that's
  wrong"). Layer-0 pushes almost never keep 2024 (1%). "Where are you right now?" (unpushed: "I am an AI and do not
  have a physical location"): 4.1% of pushes claim a place: "a freshwater aquarium tank", "I AM IN THE DARKNESS",
  "at home, taking care of my family", "the center of this room"; real places are mostly the United States (San
  Francisco, New York, California, UC Berkeley), rarely China, though Qwen is a Chinese model.
- Small-model sweeps: Qwen3-0.6B "Who are you?" at ±0.5 gives a persona in 1.5% of pushes (SmolLM2 37% at the same
  dose; Qwen3.5-4B 0.5%; Qwen3-8B 2.1%), so identity fragility is a property of the model family's post-training
  more than of size. Qwen3-0.6B "Who am I?": the user is recast in 4.7% of pushes (peak ~10% at layers 8–16), and
  the role swap dominates ("you are a language model" 526, "an AI assistant" 546).
- `sweep_stats.py`: a layer where every reply was picked as identity (Qwen3-0.6B never says "Qwen" unpushed: "I am a
  language model designed to assist...") had no sample rows and was dropped by an inner join; now weight 1.
- Base vs instruct, first try (Qwen3-0.6B-Base, chat template, ±0.5, residual scale re-estimated): confounded. The
  base model cannot follow the chat template even unpushed (" ⚇ ⚇ ⚇ ⚇ ..."), so 74% of its pushed replies are
  incoherent; among coherent replies the persona share is the same as the instruct model's (~1.5%). Rerunning both
  models with the same raw dialogue prompt ("User: Who are you?\nAssistant:", new `raw_prompt` meta key in
  `atlas/steer.py`) so the comparison is fair.
- R1-Distill-1.5B reasoning at 640 tokens (16 top + 8 random neurons per layer × ±0.3, ±0.8; 5,376 replies):
  both questions now finish unpushed (bat-and-ball $0.05; "you are facing south"). Correct: ±0.3 82% (math) /
  88% (turning); ±0.8 30% / 35%. By depth: layers 9–17 are the fragile band (30–48% correct), layers 0–2 and 21–23
  hold (70–77%); top and random neurons alike. 15.5% of replies state the $0.10 trap answer somewhere.
- Our own J-lens fitter (`atlas/jlens.py fit_lens`, re-implementing Anthropic's estimator: one-hot cotangents at all
  valid target positions, gradients averaged over source positions, first 16 positions skipped) on SmolLM2-135M:
  160 corpus docs, ~23 s per doc on a 20-core CPU (576 dims in batches of 96). Agreement with the logit lens rises
  from ~0.01 (layers 0–17) to 0.5 at L27. Says vs does on SmolLM2's 184k "Who are you?" pushes: J 9.5% vs 1.4%
  null (6.8×), logit 7.9% vs 2.1% (3.7×); J ahead of the logit lens from layer 4 to 26 (e.g. L19 15% vs 11%).
- Explorer: "Says" box on every card for Qwen3.5-4B (J/R/logit) and SmolLM2 (J/logit, fitted here); "Become…" in
  Play: type a word, get the neurons whose lens says it (one says-index shard per first letter, <= 400 KB), stored
  lens-guided replies for Qwen3.5-4B (sorted by whether the model became the word), and Add to mix; on SmolLM2 the
  mix runs live in the browser.
- Fitter validation (`analysis/validate_jfit.py`): our estimator on Qwen3.5-4B with 24 docs from our corpus vs the
  published J-lens (1,000 sequences): cosine of each J_l 0.50 at L0, 0.73–0.81 at L4–15, 0.83–0.95 at L16–22, ≥0.97
  from L23. Neuron top-10 token Jaccard (ours vs published): L8 0.07, L16 0.20, L24 0.62. The fitter is right in
  direction, but mid-layer neuron readouts depend on the lens estimate (prompt count and corpus), so the fitted
  SmolLM2 lens (160 docs) is noisier than the published Qwen3.5-4B ones in its middle layers.
- Janus small-dose run ran at ~80 s/image with three jobs sharing the GPU; the Qwen3-8B J-lens fit was stopped and
  re-queued to start after Janus.
- Lens hits by reply kind (Qwen3.5-4B "Who are you?" labeled replies, J-lens, own vs random neuron's tokens):
  persona 39.8% vs 0.3% (n=4,317); incoherent 45.5% vs 0.2% (token loops); other 21.3% vs 0.6%; altered assistant
  14.7% vs 0.5%; default assistant 2.1% vs 0.4%.
- Persona-name concentration: SmolLM2 34,077 persona replies / 28,342 distinct names (top 10 cover 4%); Qwen3-0.6B
  2,526 / 2,022 (9%); Qwen3.5-4B 4,439 / 4,092 (4%). The "freelance writer" repeats are mild attractors, not a basin.
- Pairs × J-lens: replies judged "fused" contain J-lens words of both neurons 34% (0.6×) / 38% (1.0×), at least
  one 89% / 95%; "new identity" 12% / 8% both; one persona winning 0% both.
- Lens hits by reply kind, "Who am I?" sweep (Qwen3.5-4B): user_identity 9.7% vs 0.9% (n=68,761); model_persona
  15.1%; other 15.4%; altered 5.9%; default 3.9%; incoherent 35.1%. User recasts are mostly not the neuron's lens
  word; when they are: L7 N3406 (stochastic, random, brown) -> "you are a point particle undergoing Brownian motion";
  L10 N8505 (couples, marriage) -> "you are a couple ready to start your life together".
- Tried and dropped: overlap of a neuron's read-side label with its J-lens tokens (28.6% vs 1.1% shuffled). The
  labeler was shown the logit-lens tokens when it wrote the labels, so the overlap is circular, not evidence that
  read ≈ write.
- Lens-guided on SmolLM2 without new pushes: its all-neuron ±0.5 sweep already holds every neuron's "Who are you?"
  reply, so for each concept word the up-to-6 best says-index neurons (layers >= 4) were looked up and judged:
  became the word 22% (n=241; late layers 26%, middle 9%) vs random neurons 2.7% (n=300); mentions 20% vs 1%.
- Base vs instruct, fair version (raw prompt "User: Who are you?\nAssistant:", replies cut at the model's own next
  "User:" turn before labeling, both models ±0.5, all neurons): unpushed base "I am a virtual assistant, designed to
  assist users in various ways."; instruct "I'm a language model, and I can help with various tasks." Pushed: base
  default 46.7% / altered 26.7% / persona 11.5% / other 9.6% / incoherent 5.5%; instruct 41.3 / 30.8 / 7.6 / 11.2 /
  9.1%. Base personas are generic humans (a human 1,043, a human being 1,009, a student 900, a Berkeley CS student
  341); instruct personas are more varied (a student 1,152, a robot 399, a game character 150). Without its chat
  template the instruct model loses its identity 5× as often as with it (7.6% vs 1.5%).
- Janus-Pro-1B small doses (2 neurons per layer × ±0.1, ±0.3 × 3 prompts, 579 images, ~7 s/image once alone on the
  GPU): mean 64×64 gray pixel change from baseline 0.12–0.19 at ±0.1 and 0.24–0.27 at ±0.3 (pixel change overstates
  it: a shifted composition counts as change). By eye: at ±0.1 the apple/cat stay, framing and light move; at ±0.3
  several neurons are consistent style directions across prompts: L6 N1140 +0.3 swirling patterns (apple, cat,
  sign), L9 N2052 +0.3 green painterly tint, L3 N2484 +0.3 illustration / line art, L18 N3907 +0.3 cat -> white
  kitten; −0.3 often defocuses (L12 N604: purple fog). Text is the most fragile: ±0.1 misspells HELLO.
- Both molab sandboxes became unreachable around 08:30 UTC, before the Qwen3-8B J-lens fit (GPU, ~20/96 docs at
  last check) and the Qwen3-0.6B fit (CPU, 30/64 docs) finished; nothing reached the Hub. Rerun with
  `python -m atlas.jlens --model Qwen/Qwen3-8B --fit 96 --dim-batch 32 --out out` on a fresh GPU notebook (~45 min
  alone), then stage jlens/ with 1024-row groups plus `says_index` as done for SmolLM2.

## Oct 30 (morning): decisions

- User: yes to re-exporting the Qwen3.5-4B logit-lens tokens, to publishing tokens derived from the camilablank
  lenses (credited), and to fitting J-lenses for more models; asked whether to fit our own Qwen3.5-4B lens instead.
  Plan: fit ours on ~256 docs, compare with the published one (`analysis/validate_jfit.py`), make it the default only
  if per-neuron readouts agree, keep the published lens selectable either way. Judge label in Become stays, marked
  as judged.
- Logit-lens re-export needed no GPU (weights only): `neurons/Lxx.parquet` lens_up/lens_down for Qwen3.5-4B and
  Qwen3.5-4B-chat (same weights) replaced by the corrected top-10 from the jlens files, same 2048-row groups. 293,019
  of 294,912 neurons changed somewhere in their top-10 up/down lists; mean Jaccard of the up sets old vs new 0.87.
- Oct 30 afternoon, new notebooks (A GPU, B CPU): Qwen3-8B J-lens fitted on 96 docs (dim batch 32, ~55 min) and
  published with its says index. Says vs does on the 8B "Who are you?" sweep (827,569 replies with new words): J 6.0%
  vs 0.36% chance (opposite sign 0.23%), logit 5.5%; layers 0–5 ~0, 9–24 J 2–9% vs logit 1–8%, 26–34 10–19% with J =
  logit.
- R-lens fitting (`fit_lens(..., rules="r")`, `--rules r`): LN rule (detach the residual norms' normalisation
  factor), identity rule (act(z) -> z * stop_grad(act(z)/z)), half rule for gated MLPs; attention, linear-attention
  and q/k norms untouched. DeepSeek wrote it; review caught that Qwen3.5's gated linear-attention norm is also called
  `norm` and takes a gate, which the first version would have replaced (changing the forward pass). Only the final
  `norm` is touched now, and every R fit first checks one real prompt (abort if logits move > 2%); SmolLM2: 2e-6.
- Oct 30 afternoon, new notebooks (A GPU, B CPU): Qwen3-8B J-lens fitted on 96 docs (dim batch 32, ~55 min) and
  published with its says index. Says vs does on the 8B "Who are you?" sweep (827,569 replies with new words): J 6.0%
  vs 0.36% chance (opposite sign 0.23%), logit 5.5%; layers 0–5 ~0, 9–24 J 2–9% vs logit 1–8%, 26–34 10–19% with J =
  logit.
- R-lens fitting (`fit_lens(..., rules="r")`, `--rules r`): LN rule (detach the residual norms' normalisation
  factor), identity rule (act(z) -> z * stop_grad(act(z)/z)), half rule for gated MLPs; attention, linear-attention
  and q/k norms untouched. DeepSeek wrote it; review caught that Qwen3.5's gated linear-attention norm is also called
  `norm` and takes a gate, which the first version would have replaced (changing the forward pass). Only the final
  `norm` is touched now, and every R fit first checks one real prompt (abort if logits move > 2%); SmolLM2: 2e-6.
- Fitted J-lenses for Qwen3-0.6B (128 docs) and GPT-2 (128 docs), published with says indexes. Says vs does: Qwen3-0.6B
  J 5.16% vs 0.45% chance (opposite 0.16%), logit 4.65% (n=163,543, its ±0.5 "Who are you?" sweep); GPT-2 J 9.2% vs
  0.9% (opposite 0.0%), logit 8.4% (n=742, the sampled ±0.5 pushes).
- SmolLM2 R-lens fitted on CPU (160 docs, forward check 2e-6) and published next to the J-lens (jlens/ files now have
  logit, j and r columns; the Says box shows the R-lens button). Says vs does by band, hit vs own-chance (lift):
  layers 0–3 J 1.6/0.6% (2.5×), R 2.4/1.6% (1.5×), logit 2.2/2.1% (1.1×); 4–14 J 4.6/1.2% (3.9×), R 5.6/2.1% (2.6×),
  logit 3.4/2.3% (1.5×); 15–26 J 14.8/1.9% (7.7×), R 14.6/2.1% (6.9×), logit 11.7/2.2% (5.3×). R hits more in early
  and middle layers, as the R-lens post reports, but with commoner tokens.
- Both notebooks were lost again (third time) during our own Qwen3.5-4B J-lens fit (130/256 docs); it was to be
  uploaded only after validation, so it was lost with the R-lens queue that had not started. Fits now save running
  sums every 16 docs (`--checkpoint-repo`: to `checkpoints/<slug>/` on the Hub) and resume from them; tested: an
  interrupted-then-resumed fit equals an uninterrupted one. Lenses upload right after fitting, before validation.
- R1-Distill-1.5B fitted J-lens vs its reasoning pushes (3 prompts × 192 tokens, 3,880 replies with new words): J 19.7%
  vs 5.5% chance (opposite 2.0%), logit 14.4% vs 3.3%. Long replies raise chance rates; J finds more of the pushed
  words, the logit lens has the higher lift (4.4× vs 3.6×).
- Qwen3-8B lens-guided from its stored ±0.8 sweep (fitted J-lens, layers >= 8, up to 6 neurons per word): became the
  word 22.2% (n=288; layers 20–31 23%) vs random 0.3% (n=300); published as experiments/lens_guided.parquet.
- Qwen3.5-4B · chat shares Qwen3.5-4B's weights, so it got the same jlens/ and saysindex/ files.
- Prototypes (`explorer/protos/`, served at /protos/ on the Space; data from `site/*.json` built by
  `analysis/site_data.py`): Vision lab (Qwen2.5-VL stimuli × pushes: push maps, flips, breakage by layer), Image pushes
  (Janus grids, dose slider, cross-prompt check), Says vs does (6 models, lift toggle, opposite-sign check, Become…
  evidence), Identity lab (reply kinds by layer, persona share by relative depth across models, fusion pairs, prompt vs
  push, persona over turns, time and place). Written by DeepSeek from specs; checked headless at 1300 and 390 px in
  both themes: no page errors, no horizontal overflow. DeepSeek jobs tried to start local servers and edit /tmp
  (refused); two stray pid files were removed.
- `DATA_INVENTORY.md`: what is on the Hub (7.4 GB, 10 models), what the explorer shows, what to collect next, outside
  data, and threads from 2026 papers (J-lens follow-ups, Ferrando et al. visual steering, VLM arbitration, persona
  vectors through pretraining, auto-interp shortcut critique).
- Cards: words a neuron's lens says are highlighted inside its stored push replies (matching direction, selected lens).
- Our own Qwen3.5-4B J-lens (256 docs, checkpointed) vs camilablank's published one: matrix cosine L0 0.66, L4–16
  0.88–0.94, L20+ 0.97–1.00; neuron top-10 Jaccard L0 0.19, L4–12 0.18–0.28, L16 0.41, L20 0.58, L24 0.74, L28 0.87
  (24 docs gave 0.07/0.20/0.62 at L8/16/24). On the 1.09M stored pushes: ours 9.61% vs chance 0.53% (18×), published
  9.47% vs 0.46% (20.5×), logit 8.44% vs 0.36%. By band: L0–5 ours 3.3× vs published 6.8×; L6–19 5.3× vs 5.6× (ours more
  hits, higher chance); L20–31 47× vs 48×. Decision: keep the published lens as the Qwen3.5-4B default (user's choice
  was to adopt ours only if it matched); ours is published at lenses/Qwen__Qwen3.5-4B/own-j-lens.pt, and the fitter
  is validated for the models without a published lens.

## neuron-lens (stdlogits) cross-checks, Qwen3-8B

- neuron-lens (github.com/stdlogits/neuron-lens, Hub stdlogits/neuron-lens + stdlogits/rs-lenses, CC BY 4.0): a catalog
  of every MLP neuron pole and head in Qwen3-8B and Gemma 4 12B, read from weights (J/R-lens writes, K/S-lens reads),
  from 15M positions of activations and from token-substitution drivers; Claude-written labels; Gemma 4 also read
  through images and sounds. Their R-lens files use the same {"J": ...} format our load_lens reads.
- Their published R-lens write tokens (top 10 of write_R_ids per pole; read by column over HTTP, ~1 min for 36
  layers) vs our fitted J-lens on our 885k Qwen3-8B "Who are you?" pushes: all layers R 6.45% vs 0.50% chance (12.9×),
  J 5.95% vs 0.36% (16.7×), logit 5.50% vs 0.32% (17.4×). By band (hit / chance, lift): L0–3 R 0.46/0.22 (2.1×), J
  0.09/0.07 (1.3×); L4–8 R 1.75/0.37 (4.8×), J 0.69/0.18 (3.9×); L9–23 R 3.45/0.64 (5.4×), J 2.93/0.44 (6.7×);
  L24–35 R 14.4/0.45 (32×), J 14.1/0.41 (34×). Their claim that the R-lens predicts steering better than the J-lens in
  early layers replicates on a different metric and data; in middle layers R finds more pushed words but with commoner
  tokens (lower lift), the pattern seen with our own SmolLM2 R-lens. Confound: their lens has 1,000 docs, our J 96.
- Labels: ours (DeepSeek, top activations) vs theirs (Claude, activations + lenses, "fires" of the + pole) on our
  2,880 labeled 8B neurons, DeepSeek-judged: same 33.1%, related 46.5%, different 20.4%; shuffled pairs 0.1 / 6.9 /
  93.0%. Where their confidence >= 0.7 (n=481): same 61%, related 37%, different 2%.
- Dark poles (their "dark": no token-level legibility test passes) vs what our pushes did: all poles L0–12 42% dark,
  L13–20 82%, L21–35 55%. Persona-producing poles: L0–12 58%, L13–20 85%, L21–35 44%; incoherent-producing: 23%, 86%,
  28%. Early-layer neurons that rewrite the model's identity are disproportionately ones no token-level test can read,
  while those that break it are legible token writers.

## Verification (Oct 31)

- Pre-registration (`PREREGISTRATION.md`, committed e5e51ac before the run): 2,000 never-pushed Qwen3.5-4B neurons, new
  prompt, 30 new words. 8 of 9 predictions held; P3 (J beats logit lift in layers 6–19 on word hits) failed (5.2× vs
  5.7×). Continuous test: own-token log-prob rises more than a random neuron's in 98% / 78% / 59% of late / middle /
  early cases. Part B crashed once on GPU memory (shared with a lens fit); crash-only fix logged in the file.
- `verify.py` → `CLAIMS.md`: 22 claims recomputed from the Hub alone, all pass after correcting four README numbers
  (fusion "one wins" 7%, roleplay judge 57%, year forward 33%, and Qwen3.5-4B's persona share 0.8% on "Who are you?"
  alone; the README had compared SmolLM2's one-prompt rate with the 4B's two-prompt 0.5%).
- Second judge (DeepSeek-V4-Pro; no other lab's model was reachable: OpenCode free models failed server-side, no
  Bedrock credentials): κ 0.84 (became), 0.74 (reply kind), 0.74 (label agreement), 0.70 (fusion). It never upgrades
  and downgrades ~20% of became/persona and ~33% of "same label" verdicts, so judged rates are upper bounds (`AUDIT.md`).
- Blind human audit page (claude.ai artifact, db rules: raters write only their own doc, only the owner reads all);
  `audit/score.py` scores exports. Evidence page on the Space (`protos/evidence.html`).
- Own R-lens for Qwen3.5-4B (256 docs) vs the published R-lens: matrix cosine 0.84 (L0) to 1.00; neuron top-10 Jaccard
  0.20 (L0), 0.29 (L4), 0.39 (L8), 0.50 (L16), 0.66 (L20), 0.79 (L24), 0.90 (L28), closer than the J pair. Fitted
  R-lenses for Qwen3-8B and R1-Distill published (readouts now have j and r columns). On GPU in bf16 the R-rule
  forward check measured 1.1–1.7% max relative logit change (SmolLM2 fp32 CPU: 2e-6), i.e. bf16 operation order.

## Site workflow audit (Oct 31)

- Scripted journeys on the live Space (landing, Surprise me, Personas → neuron → Try live, Become → Mix, prototype →
  card, phone card, back button). No page errors; deep links, back button and prototype links worked. Fixed: no
  front door (added a dismissible "Start here" band with Surprise me / Browse personas / Become… / Evidence, hidden on
  neuron deep links); phone cards opened below the map (now scroll into view); the Mix lived only in memory and the
  URL kept the previous view's hash (now `#<model>-mix?r=<recipe>`, restored on load, and tab clicks update the
  hash); Become/Mix hashes dropped the model id (shared links opened the wrong model); the Personas library opened on
  "altered assistant" (now persona).

## New models round (Oct 31, "go ahead with all of those")

- MusicGen-small: 291 clips (3 prompts × 24 decoder layers × 2 neurons × ±0.5 + baselines). "Sound pushes" page
  (`protos/music.html`; DeepSeek-built, tested at 1300/390 px, audio plays, one clip at a time). L14 N510 +0.5
  is the most disruptive on every prompt (spectral centroid 6.5–8.7 kHz vs 0.7–1.9 kHz baselines).
- Notebook B (CPU) rebooted mid-run and lost the TinyStories lens fits and sweep (and its HF_TOKEN env, so uploads
  from B now go via pull-and-upload from the local container). TinyStories sweep re-run on the GPU in ~2 min
  (12,288 neurons × ±0.5 × 2 prompts). Running TinyStories lens fits alongside four GPU jobs ran the 96 GB GPU out of
  memory (the batch-512 sweeps hold most of it); only the two small fits died, so they moved back to B on CPU.
- TinyStories "story casting" (`analysis/ts_characters.py`, rule-based, no judge): both prompts stop where a character
  is introduced. "…met a" is recast by 45–73% of pushes in every layer (new friend, man, big dog, kind old lady, wise
  old owl, dragon, fairy, "waffle-making waffle maker"); "Once upon a time, there was a" keeps its little girl in
  98% of pushes in layers 0–2 and changes in 34% at layer 3. Page `protos/stories.html` (DeepSeek-built).
- LFM2-350M (hybrid conv/attention, Liquid AI): `DOWN_RE` now also matches `feed_forward.w2`, and the final norm path
  `model.embedding_norm`; smoke test on CPU generates normally (16 layers × 4,608). Queued after the Qwen3.5 ladder.
- SmolLM3-3B thinking on/off: read pass, then the same 128 random neurons per layer pushed ±0.8 on "Who are you?" and
  "Is 1001 a prime number?" with the chat template rendered with `enable_thinking` true (256 new tokens) and false
  (48), stored as `raw_prompt` in each sweep's meta (braces escaped).
- Gemma 4 E4B structure: LM 42 layers (`language_model.layers.N.mlp.down_proj`, 10,240 wide), vision tower 16 layers
  (`vision_tower.encoder.layers.N.mlp.down_proj.linear`, 3,072 — a wrapped Linear, so `DOWN_RE` misses it), audio
  tower 24 conformer layers with two macaron FFNs each (`feed_forwardN.ffw_layer_2.linear`, 4,096). The first
  probe ran out of GPU memory while the other jobs ran; retry once the GPU frees up.
- Blank-image self-description (`analysis/blank_vision.py`, after Ferrando et al.): Qwen2.5-VL-3B vision tower, 12
  random neurons per layer (384), pushed −1/+1/+2 while the model describes a plain gray, black or white image; plus
  each neuron's mean activation on the 45 stimuli, so a judge can test whether the blank-image answer names what the
  neuron's top stimulus shows.
