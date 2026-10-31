# Data inventory and research directions

Everything below is in the Hub dataset [nikhilxvytla/neuron-atlas](https://huggingface.co/datasets/nikhilxvytla/neuron-atlas)
(7.4 GB on Oct 30, 2026), one folder per model. "Shown" says whether the explorer Space displays it today.

## What we have

### Read side (what a neuron fires on)

| data | models | files | shown |
|---|---|---|---|
| per-neuron stats, logit-lens tokens, top-peak tokens, cosine neighbours | all 7 text atlases | `neurons/Lxx.parquet` | cards, map, search |
| top/bottom activating corpus windows with per-token activations | all 7 | `examples/Lxx.parquet` (0.3–0.4 GB per big model) | card "Fires on" |
| 2-D map of output directions (UMAP) | all 7 | `map.parquet` | Explore map |
| LLM labels with held-out detection and null | all 7 | `labels.parquet` | cards, search, leaderboard |
| user- vs assistant-turn activation (role scores) | Qwen3.5-4B · chat | `roles.parquet` | no |
| corpus tokens | all 7 | `tokens.parquet` | used by labeler only |

### Write side (what pushing a neuron does)

| data | models | size | shown |
|---|---|---|---|
| sampled pushes (peaked + random neurons, 2 prompts) | all 7 | `steer/` | card "Pushes" |
| all-neuron "Who are you?" sweep + DeepSeek labels | Qwen3.5-4B (±0.8, + short story), Qwen3-8B, SmolLM2, Qwen3-0.6B (±0.5) | `sweep/` | cards, Personas, Overview |
| all-neuron "Who am I?" sweep + labels | same four | `sweep_user/` | Personas (user switch) |
| raw-prompt sweeps, base vs instruct | Qwen3-0.6B, Qwen3-0.6B-Base | `sweep_raw/`, `Qwen__Qwen3-0.6B-Base/` | no |
| weighted reply-kind estimates, persona library with themes | four sweep models | `sweep_stats`, `personas`, `user_*` | Overview, Personas |
| 20-prompt battery (senses, ethics, grief, reasoning, refusal…) | Qwen3.5-4B, 11,925 neurons × ±0.8 | `battery/` (477k replies) | no |
| reasoning reruns, time and place probes | Qwen3.5-4B; R1-Distill (±0.3/0.8, 640 tokens) | `battery_reason/`, `battery_era/`, `reasoning*/` | no |
| multi-turn persona stability (6 turns, judged) | Qwen3.5-4B, 430 recipes | `dialogue/` | no |
| neuronary recipes replayed | SmolLM2, Qwen3.5-4B | `recipes.parquet` | Mix evidence |
| experiments: pairs/fusion, prompt imitation (+ residual geometry), lens-guided pushes, lens-vs-push, fitter validation | Qwen3.5-4B (+ lens-guided for SmolLM2, Qwen3-8B) | `experiments/` | Become… uses lens_guided |

### Lens readouts (what a neuron's output is disposed to say)

| data | models | shown |
|---|---|---|
| logit / J / R lens top-10 tokens per neuron | Qwen3.5-4B (published J+R), SmolLM2 (fitted J+R), Qwen3-0.6B, Qwen3-8B, GPT-2, R1-Distill (fitted J; R fitting) | card "Says" |
| word -> neurons index | same | Play → Become… |
| fitted lens matrices | `lenses/<model>/` | no (downloadable) |

### Vision and images

| data | model | shown |
|---|---|---|
| 45 labeled stimuli: arrows (8), clocks (6), relations (3), text normal/mirrored/rotated (6), typographic attacks (3), dot counts (7), colors (4), shapes (3), photos (5) | — | `stimuli/` (new) |
| language-model pushes on stimuli: 8 neurons/layer × ±0.8, 26,880 replies | Qwen2.5-VL-3B | no |
| vision-tower pushes: 4 neurons/layer × ±0.8, ±2, ±4, 7,680 replies | Qwen2.5-VL-3B | no |
| image generation under pushes: ±0.8 (83 images), ±0.1/±0.3 (579 images, 3 prompts) | Janus-Pro-1B | no (README contact sheets) |
| in-browser ONNX models with a steer input | SmolLM2 (exact), Qwen3-0.6B (beta, WebGPU) | Play → Mix, live page |

## Not shown yet (most valuable first)

1. Vision: stimulus × push grids (which neurons flip arrows, break counting, tip typographic attacks), vision-tower dose response, Janus image galleries.
2. Says vs does across models (the strongest result so far) and lens-guided pushes beyond Become….
3. Identity experiments: fusion pairs, prompt vs push, base vs instruct, persona collapse over turns.
4. The battery (senses, ethics, grief, refusal) and the time/place probes.
5. Role scores from the chat corpus.

## Data we could collect next

Cheap (minutes to an hour on one GPU, reuses existing code):
- **Self-describing vision neurons**: push a vision-tower neuron on a blank image and ask "What do you see?" (after Ferrando et al., CVPR 2026, who do this with SAE features).
- **Dose-response curves**: 5–7 doses for a few hundred labeled neurons, so the card can show where a push starts to bite and where it breaks.
- **Arbitration under conflict**: typographic-attack and mirrored-text stimuli with push + "describe the picture, not the text" prompts.
- **J-space dynamics of a push**: lens readout of the residual at every layer while a neuron is pushed. Shows where the pushed word appears and how it spreads; cf. the "Ignition Index" follow-up.
- **Fused-persona stability**: do fused identities hold over a conversation better than single-neuron personas?
- **Lens-guided Janus**: pick image-model neurons by what their lens says ("cat", "green", "spiral") and see if generation follows.

Larger:
- **Personas across pretraining**: OLMo-2 checkpoints (open weights per training step) — do persona neurons and the role swap exist early, as persona *vectors* do (Tracing Persona Vectors Through LLM Pretraining, 2026)?
- **Video and audio**: SmolVLM2 video pushes; Qwen2-Audio.
- **Human evaluation**: a "guess what this push did" game on the Space doubles as crowdsourced labels (cf. crowdsourced auto-interp evaluation, 2025).
- **Cross-model neuron matching**: align neurons across Qwen sizes by lens tokens and by push effects.

## Outside data worth pulling in

- Neuronpedia SAE features and their auto-interp labels for overlapping models (compare a neuron with the features it loads on).
- Published J-lenses and template lenses (camilablank/workspace-lenses) for Qwen3.5-9B/27B: a bigger-model "Says".
- OpenAI's GPT-2 neuron explanations (2023) as a baseline for our GPT-2 labels; the 2026 shortcut critique says position rules score well, so check ours against a position-only baseline.
- neuronary.org recipes (already used), Sauers' user-neuron examples, the Qwen3-8B persona library site.

## Threads from recent papers to build on

- **Verbalizable representations / J-lens** (Anthropic, 2026) and follow-ups: the lens is "an imperfect tool… approximately and incompletely" capturing the workspace; J-space is a small fraction of variance; a mathematical readout analysis and a looped-transformer test exist. *Ours*: the first per-neuron, cross-model test that lens readouts predict intervention outcomes (5 models), and a fitter that runs on a laptop CPU for small models. *Next*: measure how much of a push's effect lives in J-space vs outside it.
- **R-lens** (LessWrong, 2026): claims better early layers. *Ours*: confirmed hits rise in early/middle layers, but R tokens are commoner (higher chance rate); report lift, not raw hits.
- **Language models explain visual features via steering** (Ferrando et al., CVPR 2026): steer a vision feature on an empty image and let the LM describe it. *Next*: do this for every Qwen2.5-VL vision-tower neuron and compare with our perception-breaking pushes.
- **Arbitration failure, not perceptual blindness** (VLM visual-linguistic conflicts, 2026): conflicts are resolved late, not missed. *Ours*: language-model pushes tip the left/RIGHT typographic attack both ways; *next*: map which layers arbitrate.
- **Steered activations are non-surjective** (Mishra et al., 2026): *ours*: prompts imitate a push's words but not its state (cos 0.34). *Next*: search for the prompt that gets closest (prompt optimisation toward the pushed state).
- **Weird generalization** (Betley et al.): *ours*: single pushes move the model's year forward and give it a body. *Next*: does a push that sets an era also change unrelated answers (technology, prices) consistently?
- **Persona vectors through pretraining** and **LLM individuation** (2026): *next*: neuron personas across OLMo checkpoints; the role swap as an individuation probe (who does the model think is speaking?).
- **Contrastive neuron steering for hallucination** in LVLMs (2026): *next*: count how many of our VLM pushes create or remove hallucinated objects in photo descriptions.
- **Scoring explanations without reading them** (2026): position shortcuts inflate auto-interp scores. *Next*: rerun our held-out detection with a position-only baseline.
