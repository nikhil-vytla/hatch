### Summary

The local-model work needed a frozen multi-task study and an installation that could produce a useful result without training dependencies. This slice adds three-seed typed-readout adaptation, complete export comparisons and a checksum-verified Mac toolkit with explicit offline `.eml` input.

It depends on the shared decision contract. The web study component and application wiring follow in the final integration PR.

<pr-train-toc>

- [Typed runtime](https://github.com/nikhil-vytla/hatch/pull/58)
- [Routing and client integration](https://github.com/nikhil-vytla/hatch/pull/59)
- [Local study and Mac toolkit](https://github.com/nikhil-vytla/hatch/pull/60) (current PR)
- [Playable scenes and design research](https://github.com/nikhil-vytla/hatch/pull/61)
- [Application and release evidence](https://github.com/nikhil-vytla/hatch/pull/62)

</pr-train-toc>

```mermaid
flowchart LR
  A["Frozen corpus and bounded search"] --> B["Validation-selected recipes"]
  B --> C["Three seeds per model"]
  C --> D["Complete decision and export evidence"]
  D --> E["Validation-only default selection"]
  E --> F["Fresh offline package verification"]
```

### Hypothesis

Small adapted readouts may support useful typed decisions across datasets. That requires comparison with state-blind, lexical, embedding and frozen-readout baselines, not a few successful examples.

### Learnings

All three models completed the selected recipe across seeds 17, 29 and 43. The corpus has 768 adaptation examples, 192 validation examples, 384 held-out decisions and 2,384 transfer decisions, including every question from all 400 released Typed Decisions cases. Candidate-selection and mapped ordinal tasks are labeled derivatives; unknown backbone exposure remains disclosed.

Laya had lower held-out derivative NLL than the lexical baseline. SmolLM2 was weaker than that baseline, and reversing options changed many causal-model answers. These results do not establish general-purpose capability. The `.eml` example scored 7/12 on authored smoke fixtures and remains experimental.

> [!NOTE]
> Review the protocol, provenance, metrics, audit/default-selection boundary and installer source first. Most result JSON/JSONL is retained measurement evidence. Downloaded backbones and converted model packages are excluded; only newly trained readouts below 100 KB are committed.

### Testing

- [x] Frozen splits, transformations and validation-only recipe selection; independent review recomputed all 27 model/seed/split aggregates.
- [x] Provider-free study/selection/export and Mac contract checks.
- [x] Explicit-model fresh installation, checksum checks, offline inference and unchanged `.eml` bytes.
- [x] All three predefined seed17 Core ML exports completed both compute conditions, retaining 17,760 decision comparisons. Agreement is 99.966% for Laya and 100% for Smol/Qwen; maximum probability drift is below 3.1e-5.
- [x] Validation selected the experimental Laya readout. Fresh proposed-registry toolkit/model directories passed installed-byte and credit checks, diagnostics and the authored first result with no model argument and networking blocked. Previously downloaded model bytes were rehashed; the earlier remote download is separate evidence.
- [x] Final provider-free checks: 10 study tests and 11 Mac tests.
- [x] Assembled branch `d627e243769e` passed locked fresh Python setup, 11 Mac tests, nine study unit tests and the full published-evidence/default audit. One corpus-integration test skipped because the private corpus cache is excluded; it passed in the measured working environment. No model download or inference ran in this branch check. No deployment or general-model superiority claim is made by this draft.
