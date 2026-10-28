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
