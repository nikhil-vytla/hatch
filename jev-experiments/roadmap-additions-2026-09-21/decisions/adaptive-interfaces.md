# Adapt a workspace without disrupting its user

- Owner: playable/design engineering, with runtime support
- Stage: next wave; source analysis starts now
- Status: experiment accepted; adaptation scope and protocol open
- Depends on: typed-decision contract, design direction, stable task state and revision handling
- Evidence: [marimo-pets analysis](../adaptive-ui-analysis.md)

## Question

Can bounded Jev decisions improve a workspace as a person's task changes while keeping their work, focus and sense of control intact?

## Direction

Use [marimo-pets](https://github.com/ktaletsk/marimo-pets), by Konstantin Taletskiy, as a starting reference for contextual notebook interaction. Credit its own upstream influences when adapting their work. The repository supplies notebook companions, visible context inspection and explicit handoff to marimo AI. Jev-driven adaptive layouts are the proposed extension, not a capability established by this source study.

Keep this experiment distinct from initial UI composition. Composition creates a layout for a brief. Adaptation changes selected parts of a working interface as declared task state changes. Share typed decisions and artifact conventions if they help; do not assume both require the same rendering engine.

Begin with a small notebook workspace and an explicit set of supported adaptations: offer a relevant help panel, expose a relevant control group, or change emphasis among existing panels. Preserve stable navigation and task data. Inspectable context should show what the decision actually received. Start with suggested changes that the user can apply, freeze or undo. Later automatic changes need separate evidence that they help without surprise.

Adaptations must preserve drafts, cell contents, selection, focus and scroll context. Use request revisions, cancellation, a minimum dwell time and a confidence policy to prevent oscillation. Do not infer permission to execute cells, change code or send extra context from a layout decision. Optional companions should not be necessary to understand or control the adaptation.

## Open decisions

- Which observable task transitions justify a change, and what context is necessary for each?
- Which changes are proposals, and is there a useful low-risk automatic subset?
- Can the integration rely on stable marimo APIs? The upstream chat bridge targets a particular frontend version, so pin and test it rather than assuming compatibility.
- Which static, heuristic and Jev conditions isolate the contribution of the model while holding available actions constant?

## Completion gate

Freeze matched notebook tasks and adaptation choices before running comparisons. Measure downstream completion, errors, recovery, intervention count, unwanted changes, layout churn, time and model overhead. Record user acceptance separately from task quality. Test rapid edits, changed focus, cancellation, offline/error states and malformed decisions; never apply a stale proposal.

Provide an immediate local example, a visible explanation of each suggested change, freeze/undo, a replayable adaptation history, and an export that excludes private notebook text by default. Verify keyboard, mobile where supported, dark mode and reduced motion. A charming pet alone does not close the adaptive-interface question. Delivery lives in the [implementation checklist](../IMPLEMENTATION.md#adaptive-notebook-interface-next-wave).
