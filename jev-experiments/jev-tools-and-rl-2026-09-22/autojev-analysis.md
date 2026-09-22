# AutoJev as a typed-decision comparison

AutoJev is a useful next-wave comparison for Jev's decision interface: an inspectable, self-hosted model with a trained readout and published probability diagnostics. The proposed experiment should ask when its probabilities support a useful review policy. The existing results do not establish general superiority, reliable natural-image decisions or a Mac-ready runtime.

## Source and release inspected

Inspected on 2026-09-22. Credit **Denis Yarats**, named in the repository's [MIT license][code-license], for [AutoJev][repo]. The GitHub account is `denis-pplx`; no further affiliation is inferred.

| Item | Pinned observation |
| --- | --- |
| Code | [`ee63c1515980491a742f0bd0685c8dc5ca1f00c3`][source], package version `0.2.0` |
| Model | [`denis-pplx/autojev-27b`][model], revision `6f5b557e037f5edb25c7dc92dbc6553e5a19c015` |
| Base | `Qwen/Qwen3.8-27B`, revision `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` |
| Selected checkpoint | Update 200, released temperature `2.207568021892729` |
| Licenses | MIT code; [Apache 2.0 model weights][model-license] with a separate [NOTICE][notice] |

The [Hugging Face API][model-metadata] reported a public, ungated model, and small metadata files downloaded without authentication. The model card's instruction to authenticate while the weights are private is stale at this inspection. The published [`decision_config.json`][decision-config] SHA-256, `bacbcbb281a53af5ef5cc6c9028601097d155bf981129f18a727219517921dcd`, matches the code release's recorded value. This checks one metadata file, not the weight shards or a complete installation. The [release manifest][release-manifest] connects the model publication to the inspected code commit.

This was source and artifact review. No weights were downloaded, no inference or training ran, and no runtime or browser performance was measured. Temporary source inspection files are not included in this project.

## What is implemented

The [model implementation][model-code] replaces generative output with a 255-option linear readout over the final hidden state. It uses single-token answer codes, masks unused options and applies a scalar temperature before softmax. The retained model weights are trainable. This differs from the completed Jev local study's frozen feature extraction and fitted readouts.

Each question receives its own prompt containing the full state and option descriptions. The server processes these branches in batches of eight. Multiple questions do not share a single cached state computation. The default input limit is 8,192 tokens per branch, with rejection rather than truncation. Zero generated tokens therefore does not mean zero cost or constant latency as questions accumulate. [Model code][model-code], [server code][server-code].

| Interface | Implemented behavior | Integration consequence |
| --- | --- | --- |
| Choice | 1 to 255 criteria; distribution and selected label | Jev's shared contract requires at least two options. Preserve stable IDs and reject unsupported requests. |
| Boolean, called `noul` | Returns the probability of true | Reconstruct false as `1 - p(true)` and validate the complete distribution. |
| Score | Server accepts 2 to 10 ordered criteria; returns distribution and expected zero-based index | Map to the declared ordinal values. Keep the expected value separate from the contract's selected supported value. |
| Images | Up to four PNG/JPEG/WebP data URLs, with decoded byte and pixel limits | Transport support is implemented; natural-image accuracy is not established by the released evaluation. |
| REST | `/v1/systemone`, model listing, health and a local playground | Isolate the GPU service from the Bun/Vercel application. |

These are source observations from [the response transformation][model-code] and [HTTP schema][server-code], not independently executed compatibility tests. Choice `confidence` rescales the maximum probability relative to a uniform distribution; score `confidence` uses a dispersion formula. Neither field should be presented as a measured chance of correctness. The evaluator instead uses the selected class probability for its calibration metrics. [Evaluation code][evaluate-code].

The server accepts Jev-like aliases, including `jev-latest`, for compatibility. They still execute AutoJev. An adapter must preserve the actual AutoJev checkpoint identity rather than count an alias as hosted Jev. Busy requests return HTTP 529; the source provides no request queue or explicit disconnect-driven cancellation of running inference. The adapter needs bounded retry and stale-result handling. [Server code][server-code].

The [package][package] targets Python 3.12+, PyTorch and Transformers, with training and serving dependencies together. The README estimates about 49 GiB for BF16 weights before runtime overhead and reports training on one H200. The loader chooses CUDA or CPU; this inspection found no MLX, Core ML or MPS implementation. A separate GPU environment is a dependency, not a capability of the current Mac installer. [README][readme], [model code][model-code].

## What the published results establish

The release reports the following on 4,700 monitored validation rows. These are upstream results, not measurements from this investigation. [Published results][results].

| Aggregate | Selected AutoJev | Hosted Jev reference |
| --- | ---: | ---: |
| Micro accuracy | 84.60% | 82.79% |
| Six-suite macro accuracy | 81.40% | 81.84% |

The ordering reverses when suites receive equal weight. The panel was used for checkpoint selection and amended after earlier results. It is not an untouched test. The release records one training seed and no uncertainty interval for this selected comparison. A separate 3,500-row fold fitted the temperature; that separation does not remove checkpoint-selection bias from the monitored panel. The ten probability-reference examples are not an empirical calibration study. [Results and limitations][results].

The [training recipe][training-config] records 73,000 curated training examples and 286 completed updates, with update 200 selected after 51,200 examples. The exact curated corpus and its images are absent. The supplied data builder produces an earlier 96,000-row corpus, and the fresh training script's evaluation chronology differs from the historical run. Code, hashes and a recipe support investigation, but do not suffice to reproduce those exact scores. The [provenance artifact][provenance] preserves these distinctions.

The evaluator supports choice and boolean tasks, not native ordinal scoring. Some public-hard score tasks were converted to choice tasks. Natural-image results and current-checkpoint latency are explicitly outside the released evidence. A Jev experiment needs its own ordinal grader, image protocol if later added, and complete timing measurements. [Evaluation code][evaluate-code], [results][results].

## Demo and useful interaction ideas

The linked demo is the locally served [playground][playground], not a verified public hosted service. Its source provides support-ticket, product-review and image-question presets, editable state and question JSON, request preview, probability bars and raw-response copying. The model page reported no hosted inference-provider deployment. This inspection did not run the playground.

A useful Jev adaptation would begin with a recorded decision and its consequences: inspect the full distribution, move a review threshold, and see which errors remain among automatically accepted decisions. Preserve the prompt, options, model revision and temperature beside the outcome. A temperature control may replay saved logits, but the interface must distinguish exploratory changes from the policy frozen before final evaluation. The existing request lifecycle should reject results after editing or reset; the inspected playground itself does not provide an abort or input-revision mechanism. [Playground source][playground].

## Fit with the lab

The [proposed decision ticket](decisions/autojev-experiment.md) extends [useful uncertainty](../roadmap/decisions/useful-uncertainty.md) through an explicit AutoJev adapter and bounded comparison. Reuse the [typed-decision contract](../roadmap/runtime/contract.ts), existing distribution validation and recorded-artifact conventions. Keep the [completed local study](../roadmap/training/README.md), its exports and installed default unchanged.

The neighboring [Jimothy proposal](decisions/jimothy-experiment.md) studies task-specific distillation into small browser models. It can share probability, coverage and batch-parity artifacts, while AutoJev tests a large general typed readout. [GEPA adaptation](../roadmap-additions-2026-09-21/decisions/gepa-domain-adaptation.md) changes instructions and criteria; the first AutoJev comparison should keep those fixed. [JevFrame](../roadmap-additions-2026-09-21/decisions/jevframe-experiment.md) may later consume the adapter, but dataframe operations are not evidence that the underlying probabilities are calibrated.

No new catalog entry, model download, training run or default promotion is implemented by this research. Text decisions should come first. Image evaluation needs a separate frozen task and cannot borrow accuracy claims from the metadata-based artwork field.

[repo]: https://github.com/denis-pplx/autojev
[source]: https://github.com/denis-pplx/autojev/tree/ee63c1515980491a742f0bd0685c8dc5ca1f00c3
[readme]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/README.md
[code-license]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/LICENSE
[package]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/pyproject.toml
[model-code]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/src/autojev/model.py
[server-code]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/src/autojev/server.py
[evaluate-code]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/src/autojev/evaluate.py
[playground]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/src/autojev/playground.html
[training-config]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/configs/training.json
[results]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/assets/results.json
[provenance]: https://github.com/denis-pplx/autojev/blob/ee63c1515980491a742f0bd0685c8dc5ca1f00c3/assets/provenance.json
[model]: https://huggingface.co/denis-pplx/autojev-27b
[model-metadata]: https://huggingface.co/api/models/denis-pplx/autojev-27b/revision/6f5b557e037f5edb25c7dc92dbc6553e5a19c015
[model-license]: https://huggingface.co/denis-pplx/autojev-27b/blob/6f5b557e037f5edb25c7dc92dbc6553e5a19c015/LICENSE
[notice]: https://huggingface.co/denis-pplx/autojev-27b/blob/6f5b557e037f5edb25c7dc92dbc6553e5a19c015/NOTICE
[decision-config]: https://huggingface.co/denis-pplx/autojev-27b/blob/6f5b557e037f5edb25c7dc92dbc6553e5a19c015/decision_config.json
[release-manifest]: https://huggingface.co/denis-pplx/autojev-27b/blob/6f5b557e037f5edb25c7dc92dbc6553e5a19c015/release-manifest.json
