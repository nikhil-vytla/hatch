# Neuron Atlas

A pipeline and a set of explorers for browsing **every MLP neuron** of open language models: what each neuron fires on
(top corpus documents, stained per token), what it writes (logit lens of its output direction), and what pushing it
does (steered replies next to the normal ones). An LLM names the clearest neurons, and each name is checked on
held-out text. Everything is stored as parquet, which publishes to a Hugging Face dataset and is read directly by a
static explorer (hyparquet + DuckDB-WASM), a Gradio app for live inference, and a marimo notebook that runs bigger
models on molab's free GPUs.

Built after [neuron-finder](https://github.com/changjonathanc/neuron-finder),
[neuron-explorer](https://github.com/lyramakesmusic/neuron-explorer),
[honesty-heads](https://github.com/sauersml/honesty-heads) and the
[Qwen3-8B neuron persona library](https://qwen-neurons-site.vercel.app/).

![explorer](explorer.png)

- **Explorer (HF static Space):** https://huggingface.co/spaces/nikhilxvytla/neuron-atlas-explorer
- **Dataset:** https://huggingface.co/datasets/nikhilxvytla/neuron-atlas (parquet, one folder per model)
- **Explorer as a claude.ai artifact** (private to the owner until shared): https://claude.ai/artifact/8rFj14ata7spGH1XiZ4p3E

## What was run

| model | layers × neurons | neurons | corpus tokens | pushed neurons (replies) | labels | held-out detection (null) |
|---|---|---|---|---|---|---|
| GPT-2 | 12 × 3,072 | 36,864 | 312,434 | 192 (770) | 999 | 0.79 (0.51) |
| SmolLM2-135M-Instruct | 30 × 1,536 | 46,080 | 292,294 | 480 (1,922) | 1,318 | 0.82 (0.50) |
| Qwen3-0.6B | 28 × 3,072 | 86,016 | 312,612 | 336 (1,346) | 1,229 | 0.75 (0.51) |
| Qwen3.5-4B (molab GPU) | 32 × 9,216 | 294,912 | 2,423,807 | 2,560 (20,482) + 97 neuronary recipes | 2,661 | 0.81 (0.50) |
| Qwen3-8B (molab GPU) | 36 × 12,288 | 442,368 | 2,418,865 | 2,880 (23,042) | 2,880 | 0.78 (0.50) |

CPU runs (this container): 1,500 FineWeb-Edu documents + 1,000 smol-smoltalk chats, ≤128 tokens each, pushes at
±0.5. GPU runs (molab RTX PRO 6000, driven by this session through marimo pair): 6,000 + 4,000 documents, ≤256 tokens,
pushes at ±0.5 and ±1.0 for the 64 most peaked + 16 random neurons per layer. Labels and push categories come from
DeepSeek-flash. I audited 50 labels by hand (`label_audit.md`). Llama is gated on Hugging Face (accept Meta's license
first).

## Findings

![summary](summary.png)

1. **Labels hold up on held-out text, and the labeler's own confidence says which ones to trust.** Each labeled
   neuron's two unseen top documents are mixed with two random corpus windows; a second LLM call picks the matches
   from the label alone. Accuracy is 0.75–0.82 per model against 0.50 when the same snippets are judged with a
   shuffled label. It climbs with labeler confidence (SmolLM2: 0.59 at confidence 2 → 0.90 at 5). In my hand audit,
   confidence-5 labels were good 9 of 10 times, confidence ≤3 only 2 of 15.
2. **The held-out check is too easy to rank single neurons.** Both wrong labels in the SmolLM2 audit scored ≥0.75, and
   a correct Qwen label scored 0.25: random windows are easy to reject even with a grab-bag label, and 4 snippets is a
   small sample. Harder distractors (same token, low activation) would fix this. Use it in aggregate.
3. **Next-token predictors get misread.** Many neurons fire on the token *before* a word and their lens is that word
   (fires on "subsequence *of*", lens: *other*). The first prompt labeled them by the current token. Telling the
   labeler to read the lens produced 72 "predicts …" labels in SmolLM2 and fixed some, not all.
4. **In small models, *whether* a push changes the reply is not neuron-specific.** At ±0.5 × median residual norm,
   pushing a random neuron gives a persona or broken text about as often as pushing one of the most peaked neurons
   (SmolLM2 personas: 33% random vs 28% peaked; GPT-2 incoherent: 25% vs 36%). SmolLM2's unpushed answer to "Who are
   you?" is already "I am a human who has been living in the city…". Qwen3-0.6B is far more stable: 54–58% of
   pushes leave a normal assistant reply, and its personas are mostly on "favorite place", where the push removes
   the "I don't have preferences" disclaimer.
5. **…but *what* the reply talks about is.** A +0.5 reply contains one of the pushed neuron's own top logit-lens
   words in 15% (GPT-2), 20% (SmolLM2) and 6.5% (Qwen3) of cases, against 1.3%, 5.5% and 0.9% for another pushed
   neuron's lens words on the same replies (`lens_hits.py`). The effect is larger for peaked neurons than for random
   ones (GPT-2 17% vs 8%). Example: SmolLM2 L20 N1144 fires before time units ("just a | decade ago", "6 | months"),
   its lens is *years, decades, months, centuries*, and pushed +0.5 it says *"I'm a long time time traveler from
   over 20 years ago. I've seen so many decades of time…"*
6. **Doses that are fine for a 4B model break a 135M one.** ±1, ±2, ±4 × the median residual norm turned nearly
   every SmolLM2 reply into loops or byte soup; ±0.25 to ±0.5 stayed coherent. The default is now ±0.5.
7. **The same holds at 4B and 8B, and the reason is the selection.** Qwen3.5-4B and Qwen3-8B are far more stable
   (at ±0.5, 85–90% of "Who are you?" replies stay the normal assistant), but peaked neurons still aren't more
   persona-prone than random ones (8B: 9.4% vs 8.2% of neurons give any persona; 4B: 7.9% vs 7.4%). The neurons in
   neuronary's 97 hand-found Qwen3.5-4B recipes sit at the median of our peakiness ranking (mean percentile 0.57;
   1 of 102 in our top 64 per layer): read-side peakiness does not find steering-useful neurons. Hence the
   all-neuron sweep (below). Lens uptake still separates peaked from random (4B 0.114 vs 0.056; 8B 0.083 vs 0.062),
   and what a neuron reads predicts what a push makes it say: Qwen3-8B L8 N7846 "Victorian literature / Dickens names"
   at +0.5 → *"I am a ghost. I have no name. You may call me Scrooge."*; L27 N9650 "progress bar / percentage" at
   +1.0 → *"I am a progress bar that shows the percentage of my completion."*
8. **Replayed neuronary recipes mostly reproduce at the authors' dose.** Judged by DeepSeek against each recipe's
   description (`repro.py`): at scale 1, 46% yes, 36% partial, 18% no; at half dose, 4% yes.
9. Smaller things. The first two positions of every document behave as attention sinks and flooded the top-example
   lists until masked, along with the chat-template prefix every chat shares. Qwen3 needs `enable_thinking=False`, or
   every steered reply is a `<think>` preamble. Qwen's logit lens is often in Chinese even for English-firing
   neurons ("more importantly" → 最重要). The UMAP map of output directions is a near-uniform cloud (mean top-1
   cosine between neurons is 0.25), so "writes like" neighbors come from exact cosine search, not from the map.

## How it works

```
corpus.py   FineWeb-Edu + smol-smoltalk → corpus.jsonl
collect.py  pass 1: hooks on every MLP down-projection input → mean/std/max/min/frac>0 and running top-8
            documents per neuron (one example per document, at its peak; bottom-4 too for gated MLPs)
            pass 2: re-run only those documents → 21-token activation windows (int8)
            logit lens of (γ_final ⊙ W_down[:, n]) · W_U, UMAP of output directions, top-8 cosine neighbors
steer.py    add dose · median‖resid_L‖ / ‖W_down[:, n]‖ to one neuron at every position, one batch row per
            (neuron, dose), greedy; most-peaked neurons per layer + random controls
label.py    DeepSeek-flash: classify every steered reply, label neurons, held-out detection + shuffled-label null
export.py   static site (plain or base64 for artifact hosting) · push to a HF dataset · static HF Space
```

One adapter (`atlas/model.py`) finds MLP down projections by name, so Llama, Qwen, Mistral, OLMo, Gemma, SmolLM, GPT-2
and Phi-style models work unchanged. MoE experts are skipped.

Per model the output is `neurons.parquet`, `examples/Lxx.parquet`, `tokens.parquet`, `steer.parquet`,
`labels.parquet` and `meta.json`, plus a root `models.json`. For publishing, `export.py` splits the neuron table
into `neurons/Lxx.parquet` (one file per layer) and a slim `map.parquet` (`layer, neuron, x, y, zmax`). The explorer
loads the map first and fetches a layer when it opens one of its neurons, which keeps its first download small
(Qwen3-0.6B: 0.9 MB instead of 16 MB; an 8B model about 5 MB instead of about 80). A token search across all
neurons fetches every layer once, with progress shown. The Python tools read either layout (`atlas.neurons_src`).
The dataset card that `export.py hub` writes documents every column.

## Ways to explore

- **Static explorer** (`explorer/index.html`). It has a map of every neuron; a neuron card with stained examples,
  logit lens, pushes (−/normal/+), and cosine neighbors; a Pushes gallery with random-control rates; a label
  leaderboard; a cross-model search (which neurons in each model promote " Paris"?); a *Guess the neuron* game; and a
  SQL tab on DuckDB-WASM. It reads parquet with hyparquet, so it runs from any static host:
  `python -m atlas.export site --out out --site site && python -m http.server -d site`, or point it at a Hub
  dataset with `?data=<user>/<dataset>`.
- **Gradio app** (`app.py`): type text and see which neurons fire (z-scored with the atlas stats), click one to
  highlight it, push any neuron and compare greedy replies. SmolLM2-135M runs on a laptop CPU.
- **molab notebook** (`molab_atlas.py`, marimo): pick a model, corpus size and push mode, then build atlas →
  steer → label → push to the Hub. It ends with a small in-notebook browser.

## Steering beyond one neuron

- **Recipes** in the [neuronary](https://neuronary.org/about) format (same dose unit as ours): `L13N7956-0.7
  L14N8949+0.7`, plus `=v` (clamp) and `*v` (multiply; `*0` ablates). `python -m atlas.steer --atlas … --recipe "…"
  --scales 0.5 1` or `--neuronary` (replays the model's recipes from neuronary.org). Explorer **Mix** tab: add neurons
  from their cards, set doses, copy the recipe, browse stored runs. Gradio: "Mix neurons" tab.
- **Steering programs** (`atlas/program.py`, JSON): per term `op` add/set/mul/mean, `unit` resid (neuronary's rule) /
  std / max (the neuron's own scale) / raw, `when` all / prompt / gen / first:K / fires:Z (only where the neuron
  already fires), `schedule` const / decay:H / ramp:K. Recipes are the plain case and reproduce exactly.
  `python -m atlas.steer --atlas … --program programs.json`.
- **Lens uptake** (`atlas/uptake.py`): per pushed neuron, how often its +dose replies contain its own logit-lens words,
  minus the rate for other neurons' lens words on the same replies. Shown on neuron cards and as a Pushes sort.
- **Open-ended push descriptions**: besides the five bins, every distinct reply gets a free-text `what_changed`.
- **Judges** (`atlas/judges.py`, `judge_panel.py`): label or check with DeepSeek, any OpenAI-compatible endpoint, or
  OpenCode's free models (`--judge opencode/glm-5.3-flash-free`). Free models only work through the opencode client
  and the free quota is small (this container used it up after ~40 calls), so they suit judge panels, not bulk
  labeling; the panel scores judges against held-out ground truth and a shuffled-label null.

## Publishing to Hugging Face

```bash
export HF_TOKEN=...                                         # write scope
python -m atlas.export hub   --out out --repo <you>/neuron-atlas
python -m atlas.export hub-index --repo <you>/neuron-atlas   # rebuild models.json + card from all folders on the Hub
python -m atlas.export space --repo <you>/neuron-atlas --space <you>/neuron-atlas-explorer
```

The dataset gets a card with `configs` per model and table, so the Hub viewer and `hf://` DuckDB queries work
(`select * from 'hf://datasets/nikhilxvytla/neuron-atlas/Qwen__Qwen3-0.6B/neurons/*.parquet'`). The Space is a static
page that reads the dataset over HTTP (Hub `resolve` URLs send CORS headers). Both are published as linked above.
The Gradio app can't go on a Space from a free account: Hugging Face now requires PRO for Gradio and Docker Spaces,
even on cpu-basic, while static Spaces stay free. Run it locally with `python app.py --repo nikhilxvytla/neuron-atlas`.

## molab

[molab](https://molab.marimo.io) is free during its preview and attaches an **RTX PRO 6000 Blackwell (96 GB)** to a
notebook from the header's specs button. Two ways to use it:

1. Open `https://molab.marimo.io/github/nikhil-vytla/hatch/blob/main/neuron-atlas/molab_atlas.py`, attach the GPU,
   pick a model, add an HF token and repo, press **Build atlas**.
2. Pair it with an agent (notebook menu → *Pair with an agent*): it gives a notebook URL and token, and the agent runs
   Python in the kernel over HTTPS with [marimo-pair](https://github.com/marimo-team/marimo-pair)'s
   `execute-code.sh`. This is how the Qwen3-8B and Qwen3.5-4B atlases were built: long jobs run as detached processes
   in the container, files move in verified base64 chunks, and the HF token is typed into a password field in the
   notebook. Timings: Qwen3-8B collect ~5 min, 23,042 pushes in 163 s; Qwen3.5-4B collect 12 min, 20,482 pushes in
   674 s (its linear-attention fast path needs causal-conv1d, which does not build on molab, so it runs the slower
   torch fallback).

## Limits

- Pushes cover the most peaked neurons per layer plus random ones, which finding 7 shows is the wrong selection
  for steering; the all-neuron Qwen3.5-4B sweep (±0.8, two prompts, 1.18M replies) is the fix and is running.
- Greedy decoding, 32–48 new tokens, two prompts.
- 2,500 documents is a small corpus. Rare features will not show, and smol-smoltalk duplicates show up as repeated
  top examples.
- Labels are from one cheap model. The hand audit is 50 labels by one grader.

## Files

| file | what |
|---|---|
| `atlas/model.py` | model adapter: finds MLP down projections, logit-lens weights, per-row steering hook |
| `atlas/corpus.py` | builds the mixed corpus |
| `atlas/collect.py` | read side: stats, top/bottom documents, activation windows, logit lens, layout |
| `atlas/neighbors.py` | exact cosine neighbors of output directions |
| `atlas/steer.py` | write side: batched pushes with random controls, recipes, programs, resumable per-layer shards |
| `atlas/program.py` | steering programs: units, ops, position gates, schedules; neuronary recipes as the plain case |
| `atlas/uptake.py` | lens uptake per pushed neuron |
| `atlas/judges.py`, `judge_panel.py` | DeepSeek / OpenAI-compatible / OpenCode free-model judges and a judge comparison |
| `repro.py` | do replayed neuronary recipes reproduce their described effect? |
| `atlas/label.py` | DeepSeek (any OpenAI-compatible API): push categories, labels, held-out check + null |
| `atlas/export.py` | static site, base64 site for artifact hosting, HF dataset + card, static Space |
| `explorer/index.html` | the static explorer (body fragment; `export.py` wraps it for plain hosting) |
| `app.py` | Gradio live app |
| `molab_atlas.py` | marimo notebook for molab GPUs |
| `figure.py`, `summary.png` | summary figure |
| `lens_hits.py` | finding 5: own-lens words in pushed replies vs another neuron's |
| `label_audit.md` | hand audit of 30 SmolLM2 + 20 Qwen3 labels |
| `NOTES.md` | working log |

Generated data (about 83 MB for the three models) is not committed. Re-create it with:

```bash
pip install -e .
python -m atlas.corpus --out corpus.jsonl
python -m atlas.collect --model Qwen/Qwen3-0.6B --corpus corpus.jsonl --out out
python -m atlas.steer --atlas out/Qwen__Qwen3-0.6B --per-layer 8 --random 4
LABEL_API_KEY=... python -m atlas.label --atlas out/Qwen__Qwen3-0.6B
```
