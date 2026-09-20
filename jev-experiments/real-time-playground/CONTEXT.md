# Jev live simulations

Experiences where a world keeps moving while a person or Jev makes decisions, with recorded trajectories available for inspection.

## Language

**Live world**:
A game or simulation that continues to evolve while its controller is thinking.
_Avoid_: A timed replay described as a live simulation

**Recorded trajectory**:
The observed sequence of a run's states and decisions, including what happened while the model was unavailable.
_Avoid_: A generated animation described as a new model run

**Checkpoint**:
A saved moment in a trajectory that can be inspected and, when supported, used as the starting point of a new run.
_Avoid_: Treating a screenshot as a restorable world

**Controller handoff**:
A change in who chooses the actor's behavior, such as a person handing the actor to Jev while the world remains in progress.
_Avoid_: Restarting the world and calling it the same run

**Fallback controller**:
Local behavior that takes over when no usable model decision is available. Its contribution remains visible separately from model control.
_Avoid_: Reporting assisted outcomes as though Jev made every decision

**Matched branch comparison**:
Runs that start from the same saved world moment and differ in a declared intervention, such as whether local fallback is allowed.
_Avoid_: Comparing unrelated seeds or starting states as a controlled intervention
