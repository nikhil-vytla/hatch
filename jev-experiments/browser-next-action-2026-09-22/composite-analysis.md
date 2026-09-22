# Composite next-action source check

[Composite Engineering Team’s article](https://research.composite.com/next-action), dated 2026-09-21, reports Qwen3.8-27B post-training on roughly 16.5K examples. Current-page text and recent actions predict clicking, typing or abstention without an explicit instruction. Its history study settled on 15 states; generalization and chained predictions remain future work.

Reported element accuracy **when acting** changes from 49.71% at 97.20% coverage after supervised training to 72.95% at 35.73% coverage at checkpoint 1024. Evaluation denominators, uncertainty intervals, held-out splits and checkpoint-selection rules are unspecified. The reward checks method and element; typing-value accuracy is not reported. These observations do not establish completed-task success or deployment reliability.

The article claims a “single forward pass” while discussing generated IDs, token budgets and DFlash. It does not resolve the number of decoding steps or model invocations. Reported latency below 400 ms lacks a serving percentile, hardware/concurrency condition and end-to-end timing boundary. No linked paper, code, weights or dataset appears among its article links.

Read-only HTTP inspection on 2026-09-22; no inference or artifact installation. Retrieved HTML: 43,644 bytes; SHA-256 `542de1822eb94e0f4ce337908e9f5269f05869f4c2ee92a26dd28adff47be01b`. The hash identifies this page snapshot, not a released model or reproducible evaluation.
