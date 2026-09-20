# Jev laboratory

The laboratory contains working experiments, recorded evaluations, and proposals for future work.

## Language

**Experiment**: A working demonstration with a specific question and an inspectable outcome. An idea without a working demonstration is a proposal.
_Avoid_: Calling an unimplemented proposal a live experiment.

**Category**: The subject a visitor wants to explore, such as Games or Productivity. Recency and execution mode are separate attributes.
_Avoid_: New, Measure, Build as category names.

**Recorded run**: A saved sequence of actual model decisions and outcomes. Its playback speed can differ from the original request latency.
_Avoid_: Calling playback live inference.

**Local decision model**: An open model that returns choices or probability distributions on the user's device. It does not imply access to Jev's weights or a reproduction of its training.
_Avoid_: Local Jev, Jev fine-tune when referring to another model family.

**Specialist**: A model fitted to training examples from the evaluated workflows. Its held-out results are distinguished from untuned model results.

**Reference label**: The dataset's supplied target. Model-generated labels measure agreement with that teacher and may be wrong.
_Avoid_: Ground truth for unverified synthetic labels.
