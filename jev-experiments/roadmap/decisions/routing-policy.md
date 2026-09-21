# Keep routing restrictions hard

- Owner: routing/integration
- Status: Resolved
- Depends on: [One typed-decision wire contract](decision-contract.md)

## Question

How can task classifiers be compared under one selector without weakening spending, capability or permission restrictions?

## Resolution

Separate classification, eligibility, selection, execution and outcome. Hard permissions, context, capabilities and budget never widen during fallback. Classifiers affect only soft task-quality ranking. Availability fallback and quality escalation are separate bounded attempts. The frozen comparison replays one policy across hosted Jev, local Laya, heuristics and host classifications; its negative outcome is retained.

## Evidence

[Toolkit and policy](../routing/README.md), [frozen comparison and results](../routing/comparison/README.md), [independent review](../playable/review/README.md).
