# Transfer the decision architecture to SmolLM2

Status: accepted, 2026-09-19.

The user requested the Kev training experiment with a different base model. Use SmolLM2-360M with a shared document prefix, isolated question branches, LoRA, and a small option-scoring head. Compare before and after training on held-out Banking77 cases, test packed-versus-separate equivalence, and publish training curves and failures. Keep downloaded base weights and trained checkpoints outside the commit; do not describe this as reproducing TypeSafe's architecture or Kev's dataset-scale results.
