# Ideas worth exploring

Speculative — not commitments. Ordered roughly by excitement × plausibility.

- **Counterfactual probes.** Because the world is a pure fold over the event
  log, you can branch at any event: replay to event k, then swap one fact or
  one decision and re-run forward with fresh streams. "Would the agent still
  have leaked if the customer had asked directly?" becomes an experiment, not
  a speculation. (The verifiers-v1 message-graph branching, lifted to worlds.)
- **Adversarial co-evolution.** Auditor actors (Petri-style) whose *generator*
  is seeded by failed verdicts from earlier populations: the chaos daemon and
  the persona generator climb toward the agent's weaknesses while staying
  citable (seed + spec lineage).
- **Contract mining.** Run a fleet of passing traces, mine candidate
  invariants (frequent always/precedes patterns), and propose them as contract
  items — steady-state discovery, as in chaos engineering practice.
- **Time-dilated surfaces.** Virtual time already decouples from wall time;
  a Surface could compress "three weeks of email" into an agent context in one
  activation — long-horizon memory evals without long-horizon costs.
- **World diffing as a review artifact.** `windtunnel diff trace-a trace-b`:
  first divergent event, entity-state deltas, verdict deltas. Makes regressions
  between agent versions reviewable like code.
- **Embodied bridge.** MuJoCo/hab-lab as a Surface + reducer pair: physics
  steps become scheduled world events; proprioception becomes StructuredParts.
  Tests whether the content-part assumption (U6) really holds for control.
- **Trace marketplace format.** The (spec, seed, trace, verdicts) quadruple is
  a self-verifying artifact — anyone can re-run the contract or the replay.
  Could become an interchange format for agent-eval reproducibility claims.
