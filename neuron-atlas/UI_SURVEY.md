# UI survey: what others do, and what to change in the explorer

Surveyed 2026-10-28. Sites: [neuronpersonas.com](https://neuronpersonas.com/) (the Neuron Persona Library, now several
models), [re:dvx](https://redvx.hyperplex.org/) (dynamic control vectors), [neuronary](https://neuronary.org/about),
[Neuronpedia](https://www.neuronpedia.org/), [Transluce](https://transluce.org/tools) (Monitor, Docent),
Theia Vogel's [repeng](https://github.com/vgel/repeng) and [introspection post](https://vgel.me/posts/qwen-introspection/),
Sauers' [honesty-heads](https://github.com/sauersml/honesty-heads). Related papers:
[Leverage Is Not Reach](https://arxiv.org/pdf/2606.19831) (single-neuron steering needs a "control window" and a
budget-normalized dose ladder), [SAEs Are Good for Steering, If You Select the Right Features](https://arxiv.org/pdf/2505.20063)
(select by output influence, not activation) — both match our finding that read-side peakiness does not pick
steering-useful neurons.

## What each one does that we don't

| site | ideas worth taking |
|---|---|
| neuronpersonas.com | **Adaptive dose ladder**: start at 1.25×, retry 1.0 / 0.75 / 0.5 until coherent, keep the strongest coherent reply. Greedy, up to **160 tokens**, stop on exact repeats. Judge returns category, **persona name**, description, tags, **weirdness 0–10, coherence 0–10**. **Library** of personas with layer range, strength, weirdness filters, "one per name", sorts (weirdest / weird-and-coherent / most coherent), **two- and three-neuron combos**, CSV download. **Atlas**: one square per layer, a dot per neuron colored by reply category, click a category to filter; per-layer share chart. **Share sheet**: poster card, copy image, download PNG, copy link, post on X, dark card. **Reproducibility**: 536 of 580 personas reproduce across three batch layouts. Models table: Qwen3-8B, Llama 3.1 8B, Gemma 4 12B, talkie. |
| re:dvx | Control vectors from contrastive persona pairs ("You are a **traditional** / **futuristic** assistant"). `dvx sweep` (compare strengths), `dvx bounds` (limits), `dvx calibrate`: **dynamic steering** scores the final prompt state and picks a per-prompt coefficient, fit from your judgments of responses. `dvx export`: vectors + adapter + chat/API server. A benchmarks page of recorded outputs. 3D (three.js) visuals. |
| neuronary | Public recipe dictionary in our dose unit; votes, comments, **reproduction reports** ("I ran it and it worked"), private drafts, dose curves, MCP + HTTP API for agents. |
| Neuronpedia | Per-feature dashboards (top examples, top logits, activation density), **live inference test** on a dashboard, **search via inference** (your text → top features), search by explanation, **steering playground with shareable saved setups**, **iframe embeds** and lists, attribution graphs (circuit tracer), 2026: **Assistant Axis** (monitor and stabilize character), Jacobian Lens, Natural Language Autoencoders; full API. |
| Transluce Monitor | Per-token **concept annotations** from AI descriptions of every neuron; **steer by description search** (find all neurons matching "X", amplify or suppress them); open neuron-description database. |
| Vogel | repeng control vectors; introspection test (inject a concept, remove it, ask "do you notice an injected thought?", read the yes/no shift); **per-layer logit-lens plots** of the answer probability. |

## Where our explorer stands (measured, Qwen3-8B on the HF Space, headless Chromium)

- First neuron card ready: **12 s**, **23 MB** downloaded, **342 MB** JS heap.
- Map hover: **496 ms per pointer move** — every move redraws all 442,368 points.
- Pushes tab: 0.7 s.

## Recommendations

### Performance (do first; cheap and measurable)
1. **Map: draw the points once into an offscreen canvas per view; hover and selection draw only the rings on top.**
   Target < 5 ms per move (from 496). Pan/zoom re-renders once per frame, not per event. Later: WebGL (regl) for
   1M-point maps.
2. **Cut the first load.** Example windows carry their own token strings (drop the 4 MB corpus `tokens.parquet` from
   the critical path); neighbor layers load when the neighbor list is opened, not with every card; steering and
   labels load per layer for big models. Target < 3 s and < 5 MB for the first card.
3. **Decode parquet in a Web Worker** so the page never freezes while a layer loads.

### Play and personas
4. **Persona library view** (neuronpersonas-style): cards with persona name, weirdness, coherence; filters for layer
   range, dose, weirdness; "one per name"; sort by weird-and-coherent; CSV. Needs the judge to return name, weirdness
   and coherence (pipeline change below).
5. **Dose scrubber on every neuron card**: a slider over all stored doses (−1 … +1, plus the sweep's ±0.8) that swaps
   the reply in place, so strength is something you feel, not a table.
6. **Program builder in the Mix tab**: per term op / unit / when / schedule controls, live JSON + neuronary string,
   copy, and "run on molab" / "run in the Gradio app" links.
7. **Concept recipes (Transluce-style)**: type "ocean", get every labeled neuron whose label matches, pick, push them
   together. Our labels already make this possible.
8. **Game variants**: "Which persona does this neuron make?" (predict the write side from the read side), "Spot the
   random control".

### Interpretability and explainability
9. **Judge-free persona score**: project each pushed reply's hidden state onto an *assistant axis* (mean difference
   between normal-assistant and persona replies, à la Neuronpedia's Assistant Axis), plot it per neuron against
   dose. Gives a continuous, reproducible measure next to the LLM label.
10. **Why this persona?** On each card, put the read side (top examples, label) beside the write side (pushed replies)
    and highlight the overlap: lens-uptake words in the reply, label words in the persona name.
11. **Per-layer logit lens of a pushed reply** (Vogel-style): how the first reply token's probability moves through
    the layers under the push.
12. **Trust signals**: labeler confidence, held-out detection, the confidence-vs-detection calibration curve, a
    reproducibility badge (rerun under another batch layout / sampling, as neuronpersonas does), and a "this label is
    wrong" flag.
13. **neuronary on the cards**: if a neuron is part of a neuronary recipe, show the recipe, its votes and our
    reproduction verdict (`repro.py`).

### Sharing
14. **Share sheet**: render a neuron or persona card to PNG (copy image, download, copy link, post on X). Works on the
    HF Space; inside a claude.ai artifact downloads are blocked, so there only copy-link.
15. **Deep links for every state** (model, neuron, tab, dose, recipe/program), and an **embed mode** (`?embed=1`) that
    renders one compact card for iframes, like Neuronpedia's embeds.
16. **Publish a recipe to neuronary** from the Mix tab (as a draft, with the user's own token and only on request).

### Pipeline changes that unlock the above
- Judge output: add persona name, tags, weirdness 0–10, coherence 0–10 (keep `what_changed`).
- Adaptive dose ladder (strongest coherent of 1.25 / 1.0 / 0.75 / 0.5) and 160-token replies for the persona prompt.
- Select neurons for pushes by **output influence**, not peakiness (or push all of them, as the running sweep does).
- Reproducibility reruns for every persona (another batch layout + one sampled seed).
