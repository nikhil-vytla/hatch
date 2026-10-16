Felix Rieseberg's essay [How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) is distilled here into `be-ambitious`, a 72-line Agent Skill in the [agentskills.io](https://agentskills.io/specification) format. It uses the principle-plus-guardrails shape of [pstack](https://cursor.com/lp-team/lauren). The skill pushes a task along three axes:

- altitude: aim at the outcome;
- depth: a deeper task rather than a bigger one, using the field's real instruments;
- range: restate nouns as verbs and bring in a crew that includes adversaries.

Every claim needs an outside judge, and the user chooses how far to go. An earlier version was a 370-line procedure with a worked example and an output template. It was cut back after an early eval showed the example's tools leaking into unrelated answers.

- The skill passes the reference validator (`uvx --from skills-ref agentskills validate`). The PyPI executable is `agentskills`, not `skills-ref`.
- The current version has not been evaluated yet.
