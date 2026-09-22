# Browser next-action research notes

- User proposed a browser agent that predicts the next action from the current page and recent history, including cross-tab preparation such as searching for a flight mentioned in an email.
- Research DOM representation, sequential prediction and learned abstention, using Composite's research as a primary reference.
- This pass adds a researched roadmap experiment. Keep current-page context, permitted history, predicted intent and executed actions distinct in the protocol.
- Checked the existing typed runtime: choice decisions already include full distributions, execution identity, limits, timing, cancellation and unsupported states. Browser-specific candidates belong in versioned state; a second wire contract is unnecessary.
- The candidate builder needs its own coverage measure. Selecting an element does not supply the date or text to type, and values must be grounded in permitted context.
- The email-to-flight flow needs positive and ambiguous examples. A preparation action must preserve the draft; incomplete travel details should not become invented constraints.
- Separated offline action prediction from fresh closed-loop fixture sessions. Later observations must reflect the agent's actual actions.
- Inspected the primary SelectiveNet page and a pinned Mind2Web README. The latter is an instruction-following dataset; removing instructions would create a derivative with additional ambiguity labels.
- The Python HTTP client could not verify the source site's certificate chain in this environment. Retried with curl's normal certificate verification; source retrieval succeeded.
- Independent protocol review found that foreground-only observation contradicted background preparation while preserving email focus. Defined one owned preparation tab as the current observed page, and required source-edit cancellation and a complete background-search fixture check.
- Refined history ablations to prevent candidate values from leaking the withheld history. Added uncertainty bounds for actions whose labels remain indeterminate.
