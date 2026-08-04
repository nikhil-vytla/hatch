Auditing three Parallax design choices against their upstream sources
settled what is replication and what is our own invention. The
[microsoft/evolving-intent](https://github.com/microsoft/evolving-intent)
evaluation (pinned commit 993d6be) runs just two conditions — single-turn
vs evolved — over a shared task-ID subset and compares aggregate mean
accuracies with no pairing or statistics, relegating its only turn-matched
control to a post-hoc appendix, so Parallax's three-arm paired design is an
addition best deferred until the cheap two-condition screen reproduces the
paper's delta. Upstream turn delivery is harness-side and unskippable — the
eval loop intercepts the agent's submission and force-injects the next
scripted turn, grading through the official SWE-bench run_evaluation
harness — which makes Parallax's agent-callable advance() tool an
undeclared deviation that should be moved harness-side or gated before any
evolved-arm result is trusted. On QC, the field splits cleanly between
executable admission gates (SWE-smith's fail-to-pass filter, Prime
Intellect's no-op + gold-patch validation) and checklist-driven human
review ([slop-code-bench](https://github.com/SprocketLab/slop-code-bench)),
supporting a code-plus-Cursor-skill combination for Parallax admission.

- Upstream published scripts do not budget-match arms: the SWE evolve
  condition gets 200 steps/turn over 7 turns vs 100 total for single-turn.
- No statistical test code exists in either upstream repo; all published
  comparisons are tables of means or descriptive percentages.
- Prime Intellect's paired no-op/gold validation with flakiness retries is
  the strongest admission QC found and is directly adaptable to Parallax.
