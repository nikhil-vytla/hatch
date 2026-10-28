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
