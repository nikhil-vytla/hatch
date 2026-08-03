# Benchmark platform for rollout data-layer experiments

Config-driven harness that runs fleets of sandboxed rollouts under
different data-layer configurations and measures every phase. It exists so
the design axes in the main README can be tested instead of argued.

Requirements: the prototype pipeline must have run first (it produces the
extracted rootfs and the access profiles this harness consumes), plus sudo
and a kernel with overlayfs. Sandboxes are real overlayfs mounts with
tmpfs dirty layers; nothing here needs a container runtime or a paid
platform.

## Run

```bash
python3 harness.py experiments/delivery_policies.json
python3 harness.py experiments/capture_regrade.json
python3 harness.py experiments/concurrency_scale.json
python3 report.py results/*.jsonl
```

## What a rollout does

1. Delivery model: given the policy, compute (upfront bytes, lazy bytes)
   from the prototype's measured access profiles; convert to modeled fetch
   seconds at the configured bandwidth. Bytes are measurements, seconds
   are arithmetic; the README is explicit about which is which.
2. Mount: overlayfs sandbox (read-only rootfs lower, tmpfs upper), timed.
3. Task: run the task script in a chroot of the mount, timed.
4. Grade: run the task's grader against the sandbox's final /work, timed.
5. Capture (optional): tar+gzip the dirty upper layer as a checkpoint,
   timed and sized.
6. Re-grade (optional): destroy the sandbox first, then restore from the
   checkpoint alone and grade again. Matching rewards demonstrate grading
   decoupled from the agent loop.

## Experiment spec

```json
{
  "name": "my_experiment",
  "tasks": ["task_csv_report"],
  "delivery_policies": ["eager_full", "lazy_none", "hot_tier",
                         "profile", "profile_loo"],
  "capture": true,
  "regrade": true,
  "repeats": 3,
  "concurrency": 4,
  "concurrency_sweep": [1, 4, 16],
  "bandwidth_mbps": 150
}
```

## Extending

- New task: drop a shell script in `../prototype/tasks/`, a grader in
  `graders/` (contract: `grader.py <work_dir>` prints reward in [0,1] on
  the last line), and trace it once with the prototype so profiles exist.
- New delivery policy: one branch in `DeliveryModel.predict()`.
- New experiment: one JSON file.
- Distribution: `run_rollout()` is a pure function of its spec row with no
  shared state. The thread pool stands in for a fleet; swapping it for a
  remote executor changes the driver, not the rollout.

## Committed results

`results/*.jsonl` are raw per-rollout records; `results/*.md` are the
aggregated tables, from a real run on a 4-vCPU host on 2026-08-03.
Headline: checkpoint capture costs 9-66 ms at 0.03-0.3 MB per rollout;
re-grade from the checkpoint reproduces every live reward; throughput on
one host is flat across concurrency 1-16 while p95 task latency degrades
11x, which is the argument for horizontal fleet scaling in one table.
