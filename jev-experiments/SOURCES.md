# Sources and what they changed

Reviewed September 19–20, 2026. Official behavior, community ideas, and our measurements are different kinds of evidence. Dataset download code pins repository commits and content hashes in each published result's `sources` field. No fetched repository is vendored here.

## Jev and the gateway

- [TypeSafe introduction](https://docs.typesafe.ai/introduction): Jev answers Choice, Score, and Noul questions against shared state. Questions are independent. This led to separate judgments for scene attributes, UI fields, rubric dimensions, and musical events, followed by deterministic composition in code.
- [Model documentation](https://docs.typesafe.ai/models): context limits and published pricing. Native pricing was $0.042 per million input tokens with free output when investigated. This is a price listing, not our measured gateway bill.
- [Confidence](https://docs.typesafe.ai/confidence): a distribution-derived signal must not be equated with an independently measured probability of correctness. Our benchmarks add Brier scores, calibration bins, and risk-versus-coverage curves.
- [Vercel Jev listing](https://vercel.com/ai-gateway/models/jev) and [evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation): the native evaluation endpoint is distinct from chat completions. We used `typesafe-ai/jev` through `/typesafe/v1/systemone`. The gateway advertised promotional zero pricing; the ledger records actual metadata and reserves for unknown costs. The response did not identify the underlying Jev version.
- [TypeSafe SDK compatibility](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe): gateway transport details. Credentials stay in server code, with separate authorization for the public lab's live calls.

## Community experiments

| Project | Useful idea | What this lab explores |
| --- | --- | --- |
| [achimala/jev-paint](https://github.com/achimala/jev-paint) | Represent drawing as bounded decisions | One question per pixel, inspectable color probabilities, deterministic renderer |
| [UI generator](https://github.com/joevidev/ui-generator-instinct-jev) | Pick UI structure from a vocabulary | Layout, density, emphasis, and fields; compare revisions for stability |
| [heist-one](https://github.com/AbdelStark/heist-one) | Use structured decisions inside an interactive world | Partial-observation MiniGrid actions, replay, legal-action constraints |
| [jev-align](https://github.com/sutro-sh/jev-align) | Jev in evaluation and alignment workflows | Independent judge labels, reward training, and prompt optimization |
| [aaazzam/jev](https://github.com/aaazzam/jev) | Compile Python types and descriptions into questions | Original Pydantic, Zod, Rust, and Go adapters that retain answer distributions |
| [Kev](https://github.com/jaredpalmer/kev) | Shared-prefix decision model with isolated branches and a pointer readout | Transfer the mechanism to SmolLM2-360M and actually train its adapters and head |
| [Representation robustness investigation](https://research.prose.md/articles/representation-robustness/) | Equivalent representations can change a judgment | Identical repeats, option reversal, distractors, and prompt injection are tested separately |

The Kev repository now contains several Qwen backbones beyond its original Qwen2.5-0.5B experiment. Our 360M SmolLM2 pilot is smaller and uses a much narrower dataset. Its measured accuracy should not be compared directly to Kev's broader evaluation suite. The architecture is a public reconstruction, not verified knowledge of TypeSafe's private implementation.

aaazzam/jev was especially useful as an API idea: put semantic descriptions beside types, then compile them into model questions. A valid `bool` does not prove the judgment is correct. Our adapters therefore return both validated values and evidence, and reject unsupported free-form output types before making a request.

## Independent evaluation and optimization

- [Banking77](https://github.com/PolyAI-LDN/task-specific-datasets): train a TF-IDF logistic baseline on the official training split, evaluate on a balanced sample of the official test split. The replica separately uses derived four-way questions.
- [CLINC150 and out-of-scope data](https://github.com/clinc/oos-eval): include out-of-scope requests explicitly. Our 400-example sample contains 100 OOS cases, so its aggregate is not the standard full-test benchmark score.
- [JudgeBench](https://github.com/ScalerLab/JudgeBench): independently labeled answer pairs. Swap response order to measure preference instability. Two orderings of one pair are not two independent underlying problems.
- [IFEval](https://github.com/google-research/google-research/tree/master/instruction_following_eval): execute the official checks against local candidates, Jev's selected answer, and a permitted reference writer. Creative quality remains unrated by humans.
- [MiniGrid](https://github.com/Farama-Foundation/Minigrid): exact rewards, reproducible seeds, and egocentric observations. The visible BFS baseline sees the same partial grid. No agent receives hidden map coordinates.
- [GEPA](https://github.com/gepa-ai/gepa): real reflective mutation through its adapter interface. Our bounded comparison freezes prompts before evaluating on test labels.
- [OPRO](https://github.com/google-deepmind/opro): motivate the prompt-history-and-score proposal loop. Our implementation is OPRO-inspired, not a reproduction of its published benchmark.
- [TextGrad](https://github.com/zou-group/textgrad): an adjacent future direction for optimizing multi-stage contracts. It is not implemented or measured in this version.

## Models and typed schemas

- [SmolLM2-360M](https://huggingface.co/HuggingFaceTB/SmolLM2-360M): different backbone for the Kev transfer. See the included artifact model card for revision and training scope.
- [Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B): local candidate generation. The Python benchmark runs the architecture in FP16 on MPS; the browser uses the [ONNX conversion](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX), so browser outputs are not identical benchmark reproductions.
- [ViT-GPT2 captioner](https://huggingface.co/Xenova/vit-gpt2-image-captioning): local image-to-text bridge. Its incorrect caption in our single screenshot test demonstrates that Jev cannot recover visual evidence discarded by perception.
- [Zod JSON Schema](https://zod.dev/json-schema), [Schemars](https://docs.rs/schemars/latest/schemars/), [Go JSON Schema](https://github.com/invopop/jsonschema), and [Go validator](https://github.com/go-playground/validator): compile finite enums, booleans, and bounded probabilities, then validate typed results. Explicit ordered-score rubrics are supported by the TypeScript, Rust, and Go adapters.

Sonnet access returned HTTP 403 for this gateway account. Gemini 2.5 Flash-Lite was permitted, with a five-request-per-minute limit. The completed writer comparisons identify the actual model used; they are not Sonnet results. The runner now paces this writer through a shared ledger rather than bypassing the account's limit.
