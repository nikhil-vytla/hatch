# GEPA adaptation: extend prompt evolution

Checked 2026-09-21. This is source review and offline arithmetic over published predictions. No package installation, model requests, training or changes to completed experiments occurred.

## Attribution and mechanism

[Adapting Jev to Your Domain with GEPA](https://praneeth16.github.io/blog/adapting-jev-with-gepa/) is by **Praneeth Paikray**, dated 2026-09-20. Its companion study is pinned at [`b746a0f0d1908adc6108e688208251e1e3b763df`](https://github.com/Praneeth16/Praneeth16.github.io/tree/b746a0f0d1908adc6108e688208251e1e3b763df/study). Comparing that revision with current `c864d4ee697206cc936c23caa3672fd716a024f6` found no study-file changes.

GEPA is a separate contribution by **Lakshya A Agrawal and collaborators**, including Shangyin Tan, Dilara Soylu and Omar Khattab; credit the full team through the [original paper](https://arxiv.org/abs/2507.19457v2) and [gepa-ai implementation](https://github.com/gepa-ai/gepa). The study uses GEPA `0.1.4`, whose tag resolves to `8b0ce6cd99a234f6b74daf37558a2ac0ce18f975`. Its [MIT license](https://github.com/gepa-ai/gepa/blob/8b0ce6cd99a234f6b74daf37558a2ac0ce18f975/LICENSE) names Agrawal; Paikray's repository carries [Apache-2.0](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/LICENSE).

This adaptation changes **instructions and two class descriptions, not weights**. The inspected [adapter](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/experiment.py) holds `jev-1.13.0`, the Choice schema and label keys fixed. GEPA samples examples, selects parents and accepts candidates; a conversation assistant supplied four textual proposals through its custom-proposer interface. The reflection model's exact version and cost are unavailable. Jev classifies sentences; it does not generate revisions. No gradient updates or model exports occur.

## What the recorded study establishes

The task is binary agreement with adverse-drug-event sentence annotations. The pinned [ADE Corpus V2 card](https://huggingface.co/datasets/ade-benchmark-corpus/ade_corpus_v2/blob/4ba01c71687dd7c996597042449448ea312126cf/README.md) lists 23,516 classification rows and an unknown license. The study reports 20,895 unique sentences after lowercase/whitespace deduplication. Its initial experiment trained TF-IDF/logistic regression on 20,395 sentences and reserved 200 validation and 300 test sentences. That baseline's validation-tuned threshold was exploratory, not preregistered.

For the GEPA follow-up, the [manifest](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/run/split_manifest.json) excludes all 500 previously evaluated Jev sentences. Seed `20260919` selects 100 reflection-training, 100 validation and 300 test examples, containing 20, 21 and 61 positives respectively. These are new Jev evaluations, but came from the earlier supervised baseline's training pool. The follow-up therefore compares two Jev prompts, not a newly held-out supervised baseline.

The optimizer maximizes `1 - (p - y)^2`, equivalent to minimizing binary Brier score. The [configuration](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/run/config.json) permits four proposals, 20-example reflection minibatches and 700 optimization evaluations; the recorded search used 660. Crossover was disabled. Validation selected candidate two before the paired test; classification uses `p >= 0.5`.

I independently recomputed these values from the [original](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/run/test_original.json) and [selected](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/run/test_gepa.json) 300-row snapshots:

| Metric | Original | Selected |
| --- | ---: | ---: |
| Brier, lower is better | 0.13566 | 0.07474 |
| Accuracy | 83.0% | 90.7% |
| Positive F1 | 69.1% | 79.7% |
| Precision / recall | 54.8% / 93.4% | 71.4% / 90.2% |
| False positives / false negatives | 47 / 4 | 22 / 6 |

Repeat this arithmetic with [gepa-check.py](gepa-check.py). It downloads only the two pinned prediction files into memory and checks matching IDs/labels before scoring. [gepa-verification.json](gepa-verification.json) preserves the resulting metrics and input hashes; it contains no source corpus text.

The trade-off matters. A separately validation-selected review cutoff of 0.4 reduced the test queue from 106 to 78 sentences, but deferred six positives instead of four. Neither prompt met the validation target of 95% positive retention on test. Brier measures probability error, including discrimination and prevalence effects; it is not solely calibration or a guarantee about review safety. Sources: [analysis](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/run/analysis.json), [study report](https://github.com/Praneeth16/Praneeth16.github.io/blob/b746a0f0d1908adc6108e688208251e1e3b763df/study/gepa/README.md).

The limitations are substantial: one task/search/model, no alternate seeds or inference-repeat study, unknown pretraining exposure, and no article IDs for document-level separation. Sentence-bootstrap intervals do not account for shared reports. Corpus agreement is not clinical validation. All 600 final test responses survive, but three optimization response payloads are missing. The reported $0.03067 Jev input estimate is a lower bound excluding those records and reflection. Median/p95 client-observed latency was 19.59/24.37 seconds across preserved calls, not isolated inference. Longer selected instructions increased average test input tokens from 424.2 to 694.2. No controlled generative-model speed comparison was run.

## Recommendation for Jev

Create a **next-wave extension of existing Prompt Evolution**, not another experiment page or an amendment to the completed local-model study. [Our optimizer already calls real GEPA](../src/jev_lab/optimize.py), alongside unchanged, random, hill-climbing and OPRO-inspired conditions. Its [existing review](../quality-and-simulation-review/experiments/optimize.md) records a valid negative held-out result and problems with outage-contaminated fitness. Paikray's positive result motivates a new identified run; it does not supersede that evidence.

The extension should:

- Add a probability-loss objective and inspectable instruction/class-description edits, with unchanged and fixed human-written rubric controls under the same evaluation budget.
- Freeze fresh splits, primary metrics, proposal limits and three search seeds before calls. Keep test labels outside reflection and selection; distinguish failed transport from completed candidate fitness.
- Version the reflector and record its full overhead, candidate ancestry, immutable predictions and freeze event. Report probability loss, classification outcomes and downstream review retention separately.
- Extend the existing prompt-optimization view with recorded candidate replay and source-linked failures. The earlier audit proposed that replay; it is not established as an existing UI capability. Validate adapter behavior offline before approving a live budget.

Keep [the completed local readout/weight adaptation study](../roadmap/training/README.md), its frozen protocol, selected default and results unchanged. A later model-by-prompt comparison would require its own protocol and fresh evaluation data. Neither prompt-search gains nor this medical pilot establish general-purpose local-model improvement.
