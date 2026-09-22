# Browser next-action glossary

Terms for the proposed browser experiment. Decisions and implementation details live in the adjacent ticket and checklist.

## Language

**Observation**:
One versioned capture of the current observed page, with permitted history ending before prediction. That page may be the user's foreground tab or an explicitly owned preparation tab.

**Intent**:
The user's inferred immediate purpose. It is uncertain and does not grant execution permission.

**Candidate action**:
A fully specified operation that the runtime could attempt against an observation, including grounded values and preconditions.

**Abstention**:
A valid model decision to wait rather than select an action.
_Avoid_: Error, policy rejection.

**Policy rejection**:
The executor refuses an otherwise valid prediction because the operation is outside the user's configured permissions.
_Avoid_: Model abstention.

**Prediction coverage**:
The fraction of all sampled opportunities at which the model predicts an action, before execution guards.

**Executable coverage**:
The fraction of all sampled opportunities that pass both prediction and execution guards.

**Selective risk**:
Full-action error among predictions that act, evaluated at a stated coverage.

**Episode**:
A session in which actions change the page and later decisions observe those changes.

**Preparation mode**:
An explicitly enabled scope for reversible browser steps such as opening a search tab and filling grounded search fields.
