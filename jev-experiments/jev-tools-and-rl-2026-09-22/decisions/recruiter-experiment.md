# Compare bounded recruiting-evidence decisions on Jev and DeepSeek

- Owner: runtime/evaluation, with experience and independent review
- Stage: next wave
- Status: source research complete; experiment proposed, deployment conformance and protocol open
- Depends on: [typed-decision contract](../../roadmap/decisions/decision-contract.md), a compatible pinned SGLang deployment, approved compute budget, synthetic evidence corpus and frozen evaluation protocol
- Evidence: [recruiter and endpoint analysis](../recruiter-analysis.md)

## Question

Can DeepSeek V4.1 Flash return useful, bounded evidence judgments through SGLang's token-scoring path at a better measured cost/latency tradeoff than generating the same structured decisions?

## Direction and credit

Use [Jev Recruiter](https://github.com/skeptrunedev/jev-recruiter/tree/bed4083bf5a8351ce21089a5ebd0f90498ffdd6c), by [skeptrune / skeptrunedev](https://github.com/skeptrunedev), as the application reference. It adapts [Browser Use's Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) and [Browser Harness](https://github.com/browser-use/browser-harness), retaining Browser Use's MIT notice. Credit the existing work; do not present its browsing, indexed observations or evidence choices as new inventions.

The initial experience assesses supplied synthetic professional evidence against explicit job criteria for a human reviewer. Each finding has supported, contradicted or unknown status, a source excerpt and uncertainty. Missing evidence stays unknown. A reviewer can inspect, correct and export the evidence record. The model must not shortlist, reject, rank applicants for employment or infer protected traits. Names, photographs and unrelated personal attributes are outside the initial input contract. This is assistance with evidence, not autonomous employment decision-making.

Do not connect an authenticated browser or use real applicant data in the first study. A future local fixture-browser phase may test observation and stale-state guards, with every action bounded by the host's permissions. Live discovery remains a separate decision.

## Endpoint contract before performance

Pin the [DeepSeek model revision](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/dba1be0a40aa45a94ad051997016db3960a90277), tokenizer, prompt encoder, SGLang source/container digest, hardware and server options. The inspected [SGLang recipe](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4_1.mdx) requires preview support. Do not substitute a stock release or claim endpoint compatibility from a model name alone.

First establish non-thinking generation using the supported server control and reference encoding. The hosted DeepSeek API instead documents `thinking.type="disabled"`; do not assume request fields or defaults transfer between servers. A literal `</think>` added to user content is an unverified workaround. The official encoder already emits that delimiter in its supported chat-mode assistant prefix. Verify full token sequences before studying a manual-prefix variant.

SGLang's [score schema](https://github.com/sgl-project/sglang/blob/367e3700cfb6a0b03b2fa41a4524febf18ec1f15/python/sglang/srt/entrypoints/openai/protocol.py#L1383-L1416) is not the Jev state/questions contract. Build a narrow adapter only after conformance: complete encoded prompts, unique single-token labels, explicit option descriptions and stable IDs, declared context/choice limits, execution identity, timing and unsupported/error states. Validate finite scores, expected dimensions, label coverage and normalization. Retain raw label mass; renormalizing a tiny subset of vocabulary is not evidence of high confidence.

Compare score outputs with the same model's native one-step logprobs on identical token IDs. Then test independent requests against batches and changed option orders. Start without packed multi-item scoring, speculative decoding or optional prefill shortcuts. Reject unsupported configurations rather than changing the prompt or truncating unnoticed.

## Frozen comparison

Use three primary conditions: hosted Jev typed decisions, V4.1 non-thinking structured generation, and V4.1 token scoring. Hold input evidence, criteria, options and downstream validation fixed. Compare the two SGLang conditions on the same deployment. A hosted DeepSeek condition, if useful, is separately labeled because its infrastructure and model serving choices differ.

Freeze calibration and held-out splits by profile/brief family, transformations, prompts, thresholds, sample size and repeats before inference. Use authored synthetic cases with independently checked criterion labels and supporting/contradicting spans. Cover explicit support, explicit contradiction, missing facts, overlapping roles, incomplete dates, source confusion, hostile instructions, long contexts and option permutations. Do not tune thresholds or select a recipe on held-out results.

## Completion gate

Publish conformance evidence before quality or speed claims. Report status accuracy, false-supported findings, unknown precision/recall, evidence-support accuracy, calibration, coverage, option-order effects and batch sensitivity. A quotation's presence is insufficient to prove that it supports the criterion. Missing and oversized inputs must have visible outcomes.

Measure complete decision latency and cost, including encoding, all status/evidence heads, network, prefill, generation or scoring, queueing, retries and validation. Separate cold and warm caches and identify measured concurrency. Record memory, actual input/output tokens and total calls; a zero-output scoring request still performs inference. Define acceptance thresholds on calibration cases and retain negative results.

Verify human correction, provenance-preserving export, keyboard/touch access, dark mode, reduced motion, cancellation and stale-result rejection. Make no hiring-quality or labor-market claims from synthetic tasks. This ticket records proposed work; installation, GPU execution and product implementation remain pending. Real-person data is outside the initial study. Implementation tasks belong in the separate folder checklist.
