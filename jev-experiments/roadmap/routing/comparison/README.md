# Bounded routing comparison

Four classifiers selected the same accessible destination on four held-out synthetic tasks. The selected GPT4.1 mini responses passed two of four deterministic graders; fixed GPT4.1 passed three. The frozen policy chose the lower priced destination and lost one additional task on this tiny held-out sample. This is an engineering comparison of recorded routes, not evidence that a classifier improves task quality or saves money.

The [initial protocol snapshot](PROTOCOL.v1.md) matches the original protocol SHA256. The [current protocol and dated amendments](PROTOCOL.md), [task corpus](tasks.json), [independent grader](grade.ts) and SHA256 lists document four calibration and four held-out cases. The initial two destinations were called once per task, serially. After the access-only amendment, the first schema-eligible alternative was called once on the same eight tasks;24 original destination attempts are retained. Four classification conditions then replayed those measured responses under one registry and policy. The root host recorded its traits before seeing answers or graders; hosted Jev and frozen local Laya each ran all eight cases. Local runs used a GPU slot explicitly released by the training agent.

| Held-out condition | Usable answers | Independent success | Category correct | Four-task total latency, replay | Token-price arithmetic plus known overhead |
|---|---|---|---|---|---|
|Fixed GPT4.1 mini|4/4|2/4|Not applicable|4.814s|$0.000834|
|Fixed GPT4.1|4/4|3/4|Not applicable|7.804s|$0.004282|
|Heuristic classifier|4/4|2/4|3/4|4.814s|$0.000834|
|Host-agent classifier|4/4|2/4|4/4|Unknown|Unknown|
|Hosted Jev classifier|4/4|2/4|4/4|6.007s|Unknown|
|Local frozen Laya classifier|4/4|2/4|3/4|6.949s|$0.000834, excluding hardware/energy|

The original Haiku calls returned HTTP errors. Those rows and the original six-condition report remain in matrix.jsonl and initial-report.json. A frozen access amendment probed GPT4.1 before GPT4.1 nano and selected the first API/schema-eligible candidate before viewing alternative benchmark answers. Its ready response included punctuation, exposing an overstrict sentinel check; the correction and unnecessary nano probe are retained in alternative-access-first-check.json and alternative-access.json. No request was rerolled.

 A separate [compatibility diagnosis](haiku-compatibility.json) returned403 with an explicit free-tier access restriction. The matrix therefore does not measure Haiku's task ability or structured-output support. A paid user may have access; the public registry should not globally disable the model because this account lacks it. The router preserves destination failures and reports readable provider messages.

GPT4.1 mini failed one calibration answer by returning invalid nested JSON. On held-out tasks it returned a cycle array where the task required a boolean, and counted three concurrent jobs where half-open endpoint handling yields two. The [matrix](matrix.jsonl) retains every original answer and error. No answer was rerolled or replaced.

The registry estimates quality using Laplace-smoothed aggregate calibration success and measured median latency. With only four calibration cases, it does not fit separate category/difficulty effects. Every category's easy/hard endpoints are therefore equal. This deliberately flat calibration means the study cannot identify a classifier's contribution to routing quality. A larger comparison with category/difficulty calibration remains open. The accessible-alternative check is complete, with GPT4.1 producing valid outputs on all eight cases.

Full category distributions exist for hosted Jev and local Laya. Their held-out mean Brier scores were0 and0.2145 respectively, on only four examples. These numbers do not establish calibration. Hosted classification median wall time was284ms over eight requests; local cold CLI median was540ms, including checksum checks and loading. Host incremental time and cost cannot be isolated, so its totals remain null. Hosted Jev monetary usage was not returned, so its total is also null. Token-price arithmetic uses provider-reported usage and the dated configured gateway rates; no invoice or savings was verified. Selection overhead is measured during replay. Verification is disabled.

To inspect or reproduce:

```sh
bun jev-experiments/roadmap/routing/comparison/run.ts matrix
bun jev-experiments/roadmap/routing/comparison/run.ts hosted
# Coordinate the local GPU slot before this command:
python3 jev-experiments/roadmap/routing/comparison/local_classify.py
bun jev-experiments/roadmap/routing/comparison/run.ts replay
```

Matrix/classifier commands skip already recorded IDs. Preserve the original files when running a new condition. The local executable and model directory are explicit parameters in the script, pointing to the fresh-install test runtime. Source credentials come from the existing gateway credential loader and are never written into the evidence.
