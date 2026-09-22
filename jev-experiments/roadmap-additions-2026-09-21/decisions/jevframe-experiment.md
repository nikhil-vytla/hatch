# Inspect decisions across a review table

- Owner: training/runtime, with root/design engineering
- Stage: next wave; source analysis starts now
- Status: experiment accepted; proposed protocol awaits freeze
- Depends on: typed-decision contract, artifact integrity, Python runner boundary, useful uncertainty
- Evidence: [pinned JevFrame analysis](../jevframe-analysis.md)

## Question

Can a table of typed decisions help someone review uncertain records, understand errors and choose a useful coverage threshold?

## Direction

Build a bounded Review Table experiment using [JevFrame](https://github.com/ktaletsk/jevframe), by Konstantin Taletskiy, under its MIT license. Pin source and package provenance and retain attribution. Its pandas/Polars integration runs through the hosted TypeSafe SDK. It is not an existing local-inference adapter or browser runtime.

Start with attributed public review sentences and recorded results. The first action filters uncertain rows immediately. Selecting a row shows its exact submitted text, questions, full distributions, explicit failure state and execution record. Editing questions can trigger an explicit run. Stable row IDs, table revisions and invalidation keep late answers from attaching to changed data.

Use the Python library in a reproducible runner or notebook to generate CSV, JSONL and manifest artifacts that the Bun application can inspect. Decide live web execution separately; a TypeScript rewrite of the SDK loop would not demonstrate use of JevFrame. Map Boolean, Choice and Score semantics to the shared contract without discarding ordinal levels or failures. Capture transport attempts, actual model identity, usage and timing separately when the accessor output omits them.

The source analysis proposes an 80-row calibration / 120-row held-out derivative of a public sentiment dataset, three matched typed questions, semantic baselines and separate wrapper-correctness checks. These sizes and the proposed request budget are a bounded starting protocol, not a frozen study or completed result. Use calibration alone for thresholds. Keep neutral/real-world prevalence claims outside this deliberately binary sampled task.

## Open decisions

- Choose package versus pinned-source execution after checking provenance and dependency isolation.
- Freeze data hashes, grouping/splits, labels, questions, metrics, baselines and request budget before inference.
- Define coverage and uncertainty policies without treating SDK confidence as calibrated correctness.
- Choose recorded and explicit BYOK modes. The upstream example's sponsored shared-cache gateway is only suitable for public data and cannot support controlled cache-latency claims.

## Completion gate

Show a working threshold-driven queue and lossless CSV/JSONL export with source and protocol hashes. Verify row/index preservation, duplicates, nulls, empty input, pandas/Polars parity, partial/malformed replies, cancellation and stale results. Publish held-out accuracy, calibration and coverage alongside failures and request/latency/cost accounting. Wrapper tests establish data handling; model results establish semantic performance for the stated sample. Keep this evidence separate from the completed local-model training study.

The [implementation checklist](../IMPLEMENTATION.md#jevframe-review-table-next-wave) tracks delivery. The catalog entry stays hidden until the default interaction and export work.
