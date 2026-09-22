# Jev as a rubric grader for GRPO

The proposed experiment replaces some generative judging with typed Jev decisions while leaving the policy, environment and reward arithmetic under code control. The first question is whether Jev preserves the reward differences that matter for learning. Faster criterion checks are useful only if they preserve task quality and reduce a measured part of the complete loop.

This is source research and a proposed next-wave design, dated 2026-09-22. No rollout generation, grading comparison or training ran for this investigation. The [decision ticket](decisions/rl-rubric-grader.md) defines the offline gate before a training pilot.

## Primary precedents

| Source and credit | Relevant evidence | Limit for this experiment |
| --- | --- | --- |
| Zhihong Shao and collaborators, [DeepSeekMath, v3](https://arxiv.org/html/2402.03300v3#S4) | GRPO samples a group from the old policy for the same question, then derives advantages from their relative rewards. Its outcome-supervision variant applies the normalized terminal reward to generated tokens. | The algorithm does not make the reward function correct. A multi-turn tool environment needs explicit trajectory, termination and token-mask semantics. |
| Anisha Gunjal and collaborators, [Rubrics as Rewards, v2](https://arxiv.org/html/2507.17746v2#S2) | Studies rubric feedback as an on-policy reward, including explicit weighted binary checks and implicit model aggregation. | This supports the design precedent. Its domain results do not establish Jev accuracy or cost. Code should aggregate our criterion outputs so that the judge cannot change weights. |
| Hugging Face, [TRL GRPOTrainer](https://huggingface.co/docs/trl/grpo_trainer) | Supports custom reward functions and tool/environment integration. Current documentation describes several reward-scaling and loss variants. | Pin a release and explicitly set normalization, clipping, KL, loss and tool-token handling. Calling every default configuration “original GRPO” would be inaccurate. |
| Prime Intellect, [verifiers](https://github.com/PrimeIntellect-ai/verifiers), and Farama, [Gymnasium environment API](https://gymnasium.farama.org/api/env/) | Established environment libraries separate rollout/state handling from evaluation. Gymnasium distinguishes termination from time-limit truncation and specifies reset/step behavior. | Reuse a suitable adapter rather than inventing a general environment engine. A reset API alone does not provide filesystem isolation, trustworthy traces or independent policy samples. |
| Sijun Tan and collaborators, [JudgeBench, v2](https://arxiv.org/abs/2410.12784v2) | Evaluates difficult response pairs against correctness-based labels, beyond agreement with preference alone. | Pairwise benchmark accuracy cannot substitute for criterion validity, trajectory auditing or learning outcomes. |
| Leo Gao, John Schulman and Jacob Hilton, [reward-model overoptimization](https://arxiv.org/abs/2210.10760v1); Jiawen Shi and collaborators, [JudgeDeceiver, v5](https://arxiv.org/abs/2403.17710v5) | The former studies proxy-reward growth diverging from a separate reference evaluator; the latter demonstrates attacks embedded in candidate responses against model judges. | Offline agreement is insufficient for deployment in an optimizing loop. These are reasons to test independent outcomes and hostile traces, not evidence that Jev has already failed those tests. |

## Proposed grading boundary

A task contains the prompt, permitted tools, sandbox specification, initial-state snapshot and a versioned rubric of `M` criteria. Freeze `N` independent rollouts from the same policy checkpoint and prompt, with a fresh equivalent sandbox for each. Record policy sampling settings, environment seeds, tool results, state transitions, final artifacts and the stopping reason. Independence means separate executions; duplicate trajectories remain valid observations and are not regenerated until they differ.

Use deterministic checks for parsable format, executable tests, exact facts and auditable forbidden operations. A failed JSON parser remains a format failure. Jev may assess genuinely semantic presentation requirements, grounded explanations or action constraints that the audit cannot formalize. It must receive the evidence needed for each criterion, including relevant actions when the final state could hide a destructive action later undone.

Represent semantic criteria as boolean questions through the [shared typed contract](../roadmap/runtime/contract.ts). Store `p(pass)`, the fixed pass/fail decision, actual grader identity, timing and explicit unsupported/error states. Keep rubric IDs, evidence hashes, deterministic results, label provenance and reward weights in a separate grading record. The shared decision contract need not become an RL-specific interface.

The proposed primary reward is a code-computed weighted fraction of passed criteria. Nonnegative weights, applicability and any hard-failure gate are fixed before rollouts are scored. For complete group rewards `r`, compute `A_i = (r_i - mean(r)) / (std_population(r) + epsilon)`, with the exact epsilon and all-equal behavior declared. These formulas are our proposed implementation choices, based on outcome-supervised GRPO, not a claim that every trainer uses them. Hard safety gates must not be offset by enough stylistic points.

Do not average away missing criteria or convert a grading outage into failure. Mark an incomplete group unavailable for an update and retain its coverage. A task failure observed in a healthy environment is different from an infrastructure failure. Using pass probabilities directly as rewards is a separate shaping condition; it changes the signal beyond the user's proposed binary rubric.

Small reward errors can change group ranking or the sign of an advantage, especially when rewards nearly tie. This follows from the normalization equation. Measure the actual effect rather than inferring it from overall judge accuracy. All-equal rewards produce no relative learning signal; report those groups separately from invalid or missing rewards.

## What can be reused

The completed [judgment-reliability study](../judgment-reliability/README.md) contains 14,880 question decisions, pairwise and whole-answer variants, repeated passes and order checks. Its [protocol and input encoding](../judgment-reliability/protocol.ts) and [recorder](../judgment-reliability/record.ts) offer input hashing, isolated evidence, native-batch mappings and immutable attempts. Preserve its corrected source-question grouping and historical limits. Those records test judging, not GRPO training.

[RewardBench 2](../rewardbench2/README.md) supplies ranking and tie diagnostics. The existing [reward learner](../src/jev_lab/teach.py) performs exact updates on a small linear policy using a complete cached reward vector. The [reward audit](../quality-and-simulation-review/experiments/reward.md) found a representation confound, so its reward/task divergence is not proof of reward hacking. This follow-up should extend the reward-learning workstream with a separately named protocol, rather than relabel that earlier demo as LLM RL.

The [GEPA decision](../roadmap-additions-2026-09-21/decisions/gepa-domain-adaptation.md) may later optimize grader instructions on development tasks. Freeze the grader throughout a policy-training comparison; simultaneous rubric and policy search would obscure the cause of a change. The [routing cost protocol](../roadmap/routing/comparison/PROTOCOL.md) provides explicit replay and unknown-cost conventions, but its four held-out engineering tasks establish no RL savings. [AutoJev](autojev-analysis.md) is a possible later grader condition with separate hardware and calibration requirements, not a prerequisite for the initial hosted-Jev comparison.

## Cost hypothesis

For `T` updates, `B` prompts per update, `N` rollouts and `M_s` semantic criteria, logical grading work grows with `T × B × N × M_s`. That multiplication is not exponential scaling. Native batching can reduce HTTP calls without eliminating question work or repeated context. Cache hits require identical evidence, rubric, model revision and grader configuration; related rollouts are not identical cache entries.

Measure total policy-generation, sandbox, deterministic-check, semantic-grader, retry, orchestration and update costs. Report cold and warm cache conditions, actual cache hits and input/output usage separately. Compare the same rubric and information with a pinned generative LLM grader, including its efficient multi-criterion request. A baseline forced into one expensive request per criterion would exaggerate savings.

Wall time follows the dependency graph and slowest unfinished rollout/group under a given concurrency limit, not the sum of nominal API latencies. Record complete group-ready latency and training-step latency in addition to throughput and per-criterion p50/p95. Any initial result is an offline grading-cost result; total training speed and independent policy quality remain unmeasured until the gated pilot runs.
