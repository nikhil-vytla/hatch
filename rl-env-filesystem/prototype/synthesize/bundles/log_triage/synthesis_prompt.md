# Task synthesis request

You are generating an agent task from user-supplied files and a description.

## User description

Triage this service log: identify the dominant failure, when it started, and write an incident_summary.md; check the policy file for any reporting requirements.

## Seed file inventory

- `policy.txt` (text, 183 bytes, sha256 43612bb39eff...)
  sample:
  ```
  Expense policy v3:
- Meals over $75 require a receipt.
- Equipment over $1000 requires manager pre-approval noted in the report.
- All travel requires a receipt regardless of amount.
  ```
- `service.log` (logs, 337 bytes, sha256 91f2de94ba20...)
  sample:
  ```
  2026-06-01T10:02:11Z INFO  api    request ok path=/v1/rollouts
2026-06-01T10:02:14Z ERROR api    db timeout after 30s path=/v1/rollouts
2026-06-01T10:02:15Z ERROR api    db timeout after 30s path=/v1/rollouts
2026-06-01T10:04:02Z WARN  worker retry queue depth=1204
2026-06-01T10:05:44Z ERROR api    db timeout after 30s path=/v1/grades
  ```

## Produce

1. `scenario.md`: the prompt shown to the agent. It must reference seed
   files by their paths under /work/seed and define a concrete, verifiable
   deliverable.
2. `grader.py`: implements `grade() -> float` in [0,1] per the contract in
   grader_stub.py. Prefer checks over final filesystem state (files the
   agent must create or modify), so grading works from a state checkpoint
   without a live agent. Unchanged seed state must score 0.0. Include at
   least one check that cannot be satisfied by an empty or trivial output.
3. `validation.md`: describe the null baseline (no-op agent) and oracle
   (reference solution) you would run to check that grade(null)=0 and
   grade(oracle)=1 before the task is published.
