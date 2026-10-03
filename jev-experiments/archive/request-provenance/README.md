# Where experiment 28's requests came from

Experiment 28, "A writer and an editor," contains 60 recorded requests. Verified against the published [experiment data](https://jev-experiments.vercel.app/data/language.json) and the repository record on September 20, 2026.

- **40 IFEval benchmark prompts.** The loader takes Google's `instruction_following_eval/data/input_data.jsonl`, shuffles it with seed 42, and selects 40 rows. The recorded upstream commit is `4700efb9afa54286b0e04473ba80a13e8461e25f`. The first request, about mythology in Jordan Peterson's work, is case `ifeval/1601`.
- **20 creative prompts authored for this experiment.** These are the `CREATIVE` list in [language.py](../src/jev_lab/language.py), such as a robot gardening poem, an underwater library description, and writing-app names.

See the [pinned IFEval source](https://github.com/google-research/google-research/blob/4700efb9afa54286b0e04473ba80a13e8461e25f/instruction_following_eval/data/input_data.jsonl) and the [sampling code](../src/jev_lab/data.py). These requests were prepared as experiment inputs, not collected from visitors.

Qwen3-0.6B generated four candidate responses per request. Jev judged and selected among those candidates. Gemini 2.5 Flash-Lite generated the separate reference response. The reported instruction-following pass rates use the 40 IFEval cases; the creative cases have no independent human-preference evaluation.

The UI exposes case IDs and full records but should explain the source split next to the request. This investigation only documents provenance and does not change the app.
