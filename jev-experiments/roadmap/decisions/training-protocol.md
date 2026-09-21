# Freeze training and export criteria

- Owner: training/runtime
- Status: Resolved protocol; execution tracked separately
- Depends on: [Typed contract](decision-contract.md)

## Question

Which transformations, validation metrics and search bounds permit a defensible comparison across Laya, SmolLM2 and Qwen3?

## Resolution

Use the frozen versioned corpus and bounded readout-adaptation recipe in the protocol. Select recipes and temperature on validation only, repeat selected recipes across three seeds, and evaluate all400 Typed Decisions test cases only as transfer. Published backbone overlap remains partly unknown. Full CoreML comparisons, robustness, latency and coverage are required evidence. A post-freeze metric bugfix retains before/after evidence without changing NLL-based selection.

## Evidence

[Frozen protocol](../training/PROTOCOL.md), [Fable dispositions](../training/REVIEW-DISPOSITION.md), [metric correction](../training/metric-correction.json), [release status](../training/release-status.json).
