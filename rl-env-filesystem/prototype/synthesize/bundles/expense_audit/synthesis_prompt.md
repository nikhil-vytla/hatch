# Task synthesis request

You are generating an agent task from user-supplied files and a description.

## User description

Audit these expense reports against the policy and produce violations.csv listing each violating row and the rule it breaks.

## Seed file inventory

- `expenses.csv` (tabular, 212 bytes, sha256 d81072634a69...)
  sample:
  ```
  date,employee,category,amount,receipt
2026-05-02,jkim,travel,1240.50,yes
2026-05-03,mchen,meals,842.00,no
2026-05-03,jkim,meals,61.20,yes
2026-05-07,rpatel,equipment,2999.99,no
  ```
- `policy.txt` (text, 183 bytes, sha256 43612bb39eff...)
  sample:
  ```
  Expense policy v3:
- Meals over $75 require a receipt.
- Equipment over $1000 requires manager pre-approval noted in the report.
- All travel requires a receipt regardless of amount.
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
