# Altitude

Altitude means asking for the outcome rather than the next task. The guiding question: once this task is done, what do you want to happen next? Keep asking until you reach the goal behind the goal.

## How to climb

1. Start from rung 0, the task as stated.
2. Ask "why does the user want this done?" and write the answer as a result someone could observe.
3. Repeat. Stop at the last level that is still **concrete and checkable**. "Keep the desktop app crash-free across releases" can be checked. "Make the product successful" can't, and models still do poorly with goals that open-ended. Models handle more abstraction with each generation, so test one level higher than you think will work, and step back down if the plan comes out vague.

## Signals that altitude applies

- **The work would normally take a meeting.** Meetings exist to turn information into decisions. A model that holds all the data can draft the decision itself.
- **The same request keeps coming back.** Ten separate "fix this crash" requests are really one standing goal.
- **The output only exists to set off something else.** Examples: a report written so someone decides, or a deck made so a budget moves.

## Durable workflows

High-altitude asks only pay off when the model can keep working without a person prompting each step. Design that loop on purpose:

- **Inputs**: what live data does it watch? Crash reports, metrics, tickets, the CRM.
- **Mappings**: what context does it need to act? Version→commit maps, owners, schemas.
- **Verification**: how does it confirm each action worked on its own? Machines on each target OS, a staging environment, a holdout dataset.
- **Cadence and hand-off**: when does it run, and what does it bring to a human?

Building this usually changes the user's own workflow. In the source article, the author had to give the model crash reports, the mapping from versions to commits, and machines on each OS before "keep it crash-free" could be delegated. List these changes as costs on the rung, not hidden assumptions.

## Altitude ladder pattern

For a recurring business artefact, three rungs usually exist:

1. **Analyse**: hand over all the raw data and ask what changed, why, and what to do.
2. **Decide**: ask for the few most urgent decisions, each with the strongest case for and against.
3. **Redesign the process**: ask for a better mechanism than the artefact for catching the same problems sooner. Back-test it against history, then run it in parallel with the old process for one cycle before switching.

Rung 3 is where the leverage is, and it's also the rung that most needs an outside judge (the back-test and the parallel run).
