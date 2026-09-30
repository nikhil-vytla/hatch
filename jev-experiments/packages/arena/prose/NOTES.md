# Prose studies: working notes

Append-only log of what was tried and learned.

## 2026-09-29

- Read the Decide README (rewording never flipped Jev in 40 tries; answer shape and splitting
  did), the recordings README (position/batching robustness on Tetris spots: reversed order
  moved judgements 0.027 on average, one-at-a-time 0.049), the checkable README (Jev strong on
  reading/judging, weak on counting and route-finding; calibration error 0.010 on judgement
  items) and the Banking77/CLINC robustness summary in `jev-experiments/README.md`.
- Chose one question per request for every variant, so no variant sees another variant's
  wording. Batching variants would contaminate them.
- Feasibility pilot (`pilot.ts`, 2 requests, excluded from analysis): the gateway accepts a
  plain-string state and an empty-object state. Both answered by host `typesafe-ai`, 270–282
  input tokens, $0.0000113–0.0000118 each, no busy replies. A plain yes/no answer comes back
  with two decimals (0.98, 0.66).
