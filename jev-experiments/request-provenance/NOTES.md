# Experiment 28 request provenance

- User asked where experiment 28's requests came from.
- Checked the current app catalog. Experiment 28 is `language`, titled "A writer and an editor".
- Tracing the recorded data and code that produced it.
- The published `/data/language.json` matches the repository record: 40 IFEval cases and 20 authored creative prompts, from run `20260920T060138-language_reference-57aebb`.
- `data.py:123` loads Google's IFEval dataset, shuffles with seed 42, and takes 40 rows. The source commit is `4700efb9afa54286b0e04473ba80a13e8461e25f`.
- `language.py:12` defines the 20 creative prompts. `language.py:186` combines them with the benchmark sample.
- The first displayed request is IFEval case 1601, about mythology in Jordan Peterson's work.
- Local Qwen3-0.6B generated four candidate responses per request; Jev selected among them. Gemini 2.5 Flash-Lite supplied the separate reference responses.
- The UI displays the full prompts and case IDs but does not plainly explain the 40/20 source split. No application code changed during this investigation.
