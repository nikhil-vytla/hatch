# Jev Recruiter and a bounded DeepSeek scoring study

Primary-source review completed 2026-09-22. No model weights, packages or extensions were installed. No inference, browser control or real-person assessment was performed. Endpoint compatibility and performance remain unmeasured.

## Attribution and inspected revisions

| Project | Inspected source | Credit and license |
| --- | --- | --- |
| Jev Recruiter | [`bed4083bf5a8351ce21089a5ebd0f90498ffdd6c`](https://github.com/skeptrunedev/jev-recruiter/tree/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c), commit dated 2026-09-19 UTC | Creator's public identity is [skeptrune / `skeptrunedev`](https://github.com/skeptrunedev). The [MIT license](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/LICENSE) retains copyright 2026 Browser Use. |
| DeepSeek-V4.1-Flash | Official model repository [`dba1be0a40aa45a94ad051997016db3960a90277`](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/dba1be0a40aa45a94ad051997016db3960a90277) | DeepSeek-AI; repository and weights use the [MIT license](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/LICENSE). |
| SGLang | [`367e3700cfb6a0b03b2fa41a4524febf18ec1f15`](https://github.com/sgl-project/sglang/tree/367e3700cfb6a0b03b2fa41a4524febf18ec1f15), current `main` returned during review | SGLang contributors; [Apache-2.0](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/LICENSE). This source pin is not a claim about a released package. |

The recruiter's [README credits](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/README.md#credits-and-license) identify [Browser Use's Jev Ultrafast](https://github.com/browser-use/jev-ultrafast), [Browser Harness](https://github.com/browser-use/browser-harness) and TypeSafe's Jev as its foundations. Retain both the adaptation credit and original license when reusing code. No upstream code or media is copied into this folder.

## What already exists

The recruiter is a local workspace connected to a signed-in Chrome session. It gathers visible professional-profile observations, selects navigation targets, saves discovered links and presents criterion findings beside source quotations for human review. Screenshots serve the interface; model decisions use structured observations. The README distinguishes a potential match from a verified qualification or hiring decision, and labels its demo footage accelerated. Its inherited flight measurements do not measure recruiting quality. [Pinned README](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/README.md).

The [runtime manifest](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/pyproject.toml) requires Python 3.12+, `browser-harness==0.1.13` and HTTPX. The [provider resolver](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/jev_ultrafast/decision_provider.py) accepts TypeSafe or Morph, each using the state/questions contract. It rejects other provider names rather than falling back. DeepSeek/SGLang support therefore requires an adapter, not a different endpoint string.

[Title screening](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/jev_ultrafast/discovery_model.py) handles up to 30 observed profile cards and selects role relevance plus indexed supporting text. [Criterion assessment](https://github.com/skeptrunedev/jev-recruiter/blob/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c/jev_ultrafast/recruiting_model.py) accepts 1–20 criteria, creates bounded evidence windows and asks separate status/evidence questions. Status choices distinguish supported, contradicted and unknown. Code resolves quotations from observed text and turns unsupported non-unknown findings back into unknown. This establishes quotation provenance, not correctness of interpretation. The policy text instructs the model to avoid protected traits and to handle missing evidence and overlapping employment dates conservatively; those instructions still need task-level evaluation.

## Exact model and non-thinking support

Official DeepSeek documentation identifies the current `deepseek-flash` API model as **DeepSeek V4.1 Flash**. Older V4 Flash aliases temporarily route to it, so an alias alone is insufficient execution provenance. The supported OpenAI-format control is `thinking: {"type": "disabled"}`; thinking is otherwise enabled by default in the hosted API. [Current changelog](https://api-docs.deepseek.com/updates/), [thinking-mode reference](https://api-docs.deepseek.com/guides/thinking_mode/).

The official [model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/README.md) supplies open weights and a standalone prompt encoder, with no Jinja chat template in this release. Its model size and deployment requirements make this a separate server-inference study, not an assumed addition to the Mac toolkit. Do not infer a laptop memory requirement from activated parameter count.

The [SGLang V4.1 cookbook](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4_1.mdx) requires preview builds at this pin. It documents non-thinking as the default unless enabled, with `reasoning_effort="none"` switching it off. This differs from the hosted API default. SGLang's [chat path](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/python/sglang/srt/entrypoints/openai/serving_chat.py#L1451-L1585) explicitly calls a V4.1 encoder; a reasoning parser separates produced reasoning but does not itself suppress generation.

The closing-tag idea has a precise supported counterpart: DeepSeek's [reference encoding](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/encoding/README.md) renders `</think>` after the assistant prefix in `thinking_mode="chat"`. Adding the same characters to arbitrary user text is not established as equivalent. Start with supported non-thinking mode and compare the rendered token sequence against the reference. Keep a manually altered prefix as an optional, separately labeled hypothesis only if it answers a remaining compatibility question. It is not a proven latency improvement.

## What `/v1/score` means

The pinned SGLang [schema](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/python/sglang/srt/entrypoints/openai/protocol.py#L1383-L1416) accepts `query`, `items`, `label_token_ids`, `apply_softmax` and `item_first`. It does not accept chat messages or a thinking-mode field. The [HTTP handler](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/python/sglang/srt/entrypoints/openai/serving_score.py) returns one score vector per item plus usage.

For causal language models, the [score implementation](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/python/sglang/srt/managers/tokenizer_manager_score_mixin.py#L439-L710) obtains next-token label probabilities through native generation requests with `max_new_tokens=0`. Without softmax it exponentiates label log probabilities; with softmax it renormalizes over the selected labels. Default scoring composes independent query/item prompts. An optional multi-item mode uses a different packed format and must not be assumed equivalent.

Consequently, the proposed adapter must render the complete non-thinking assistant prefix before scoring, verify single-token labels with the pinned tokenizer, and map labels back to typed choices. A single token score is not a likelihood for an arbitrary multi-token answer. Label-normalized probabilities are not calibrated probabilities of professional competence. Record raw selected-label mass and validate calibration on the actual evidence task.

The existence of this generic scorer and a V4.1 deployment recipe does not prove that their exact combination works. The cookbook also describes batch-composition differences and optional optimizations that restrict logprob behavior. Require an exact-build conformance run before using this endpoint for experiments. Hold speculative and packed-scoring optimizations off initially. No endpoint was called in this review.

## Proposed study and useful experience

Begin with synthetic profile excerpts and job-related criteria. Show the criterion, model status, uncertainty, exact evidence and a human correction control together. Keep review, shortlist and employment decisions with the human; do not infer protected traits or build an automatic rejection/ranking workflow. The first example needs no authenticated site or real applicant record.

Use the same frozen state and choices for hosted Jev, SGLang V4.1 non-thinking structured generation, and SGLang V4.1 token-label scoring. Compare the latter two on the same checkpoint, hardware and server configuration. A hosted DeepSeek reference is a different deployment condition, not an isolated measurement of `/score` versus generation.

Measure per-criterion correctness, unknown handling, evidence support, false support, calibration, option-order sensitivity and batch independence. Include long inputs, partial dates, concurrent roles, contradictory excerpts, irrelevant nearby text and embedded instructions. Report truncation/omission explicitly. Measure full decision latency, prefill/scoring or generation time, tokenization, retries, calls per criterion, cold/warm behavior, concurrency, memory and complete cost. Token-label readout can avoid generating a long answer; it still pays for prompt processing and may repeat that work across questions.

The [next-wave decision](decisions/recruiter-experiment.md) defines the completion gate. This study extends the shared typed-decision runtime and evidence inspection work. Browser discovery, actual applicant use and any distribution as a recruiting product require later, separately reviewed scope.
