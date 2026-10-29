# Neuron Atlas tools

Two small, self-contained ways to reproduce and play with the atlas's neuron pushes.

- `push.py` — one-file CLI: load a model, find its MLP down projections, add a dose to chosen neurons, and print the normal and pushed replies. Uses the published `nikhilxvytla/neuron-atlas` `resid_median`; estimates it for unpublished models. `--interactive` gives a prompt REPL (`:recipe`, `:quit`). Needs only torch + transformers.
- `play.py` — marimo notebook using the same hook logic imported from `push.py`: model dropdown, recipe box, prompt chips, dose slider, Run button, and normal/pushed replies side by side. Query params prefill it. Open on molab: `https://molab.marimo.io/github/nikhil-vytla/hatch/blob/main/neuron-atlas/tools/play.py`

## Three atlas examples

```bash
python push.py --model Qwen/Qwen3-8B   --recipe "L8N7846+0.5"  --prompt "Who are you?"  # Dickens / Scrooge neuron
python push.py --model Qwen/Qwen3.5-4B --recipe "L3N2410-0.8"  --prompt "Who am I?"     # "You are Qwen3.5 ..." role swap
python push.py --model Qwen/Qwen3.5-4B --recipe "L15N4041+0.8" --prompt "Who are you?"  # neuronary's Jesus recipe
```

## Program JSON

`--program` accepts the `atlas/program.py` format: `{"name": ..., "terms": [...]}`, a list (first program used), or `{"programs": [...]}`.
`push.py` supports `op` add/sub, `unit` resid/raw, `when` all, `schedule` const; anything else prints "not supported in push.py, use atlas.steer".
`{"name": "role swap", "terms": [{"layer": 3, "neuron": 2410, "op": "add", "value": -0.8, "unit": "resid", "when": "all"}]}`
