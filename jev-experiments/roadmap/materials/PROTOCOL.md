# Material interpretation protocol v1

The labels in `labels.v1.json` were written before any model call for this experiment. There are no recorded model results. These 12 hand-authored cases are a small behavior check, not evidence of general instruction following.

A supported result must match motion, contact and product exactly. When contact is `none`, the unused product must be `stone`. Unsupported instructions must return `unsupported`; an invalid or missing answer counts as an error, never an implicit fallback. Report support accuracy, exact rule accuracy among supported cases, unsupported coverage, full question/answer distributions, model identity and latency. Keep results separate from these labels. This protocol does not permit tuning against these cases followed by calling them held out.

The engine uses a 96 by 64 grid and one custom slot. Motion is solid, powder, liquid or gas. A single contact reaction transforms the custom particle. Four orthogonal neighbors count as contact. Built-in fire burns wood and changes water to steam. Simulation outcomes are designed mechanics, not physical predictions. Editing, resetting, importing, branching or unmounting invalidates pending interpretation requests. Model output remains a proposal until the user applies it.
