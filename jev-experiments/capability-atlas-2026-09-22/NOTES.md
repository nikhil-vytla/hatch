# Jev capability atlas notes

- User requested a visual explanation of how each experiment uses Jev, an audit against the advanced primitive documentation, and recommendations for deeper existing experiments or additional studies.
- Start from actual call sites and current artifacts. Distinguish implemented code, recorded hosted results, local substitutes, proposed work and unsupported capabilities.
- The visual should make the model's input, question, output and effect inspectable for each experiment.
- The catalog contains 41 entries. Split the call-site audit across playable/productivity work, tooling/benchmarks and training/runtime, then reconcile against the catalog snapshot.
- Native structured criteria are a transport limitation today. JSON state and stringified JSON criteria must not be counted as native EntryType support.
- Provider-free probes reproduced validation rejection, extra-field loss and changed Score semantics. No new paid provider runs are part of this audit.
- Chose a shared data artifact for the standalone atlas and compact per-experiment disclosure. The authored HTML is self-contained, uses no external scripts or fonts, and exports its audit data.
- The existing first-release map needs a foundations correction for native primitive preservation; a schema that silently drops criteria cannot support an honest advanced-capability comparison.
- Independent review caught a lost keyboard focus after list selection, an incomplete search index and a stale detail pane after filtering. Fixed all three and added browser assertions.
- A mobile browser check found overflow in the structured-question code examples. Set the grid children to shrink and keep horizontal scrolling inside code blocks.
- The clean reference catalog has 40 entries; the local audited catalog has 41. Added source and routing fingerprints so a different build displays the dated audit link instead of current-behavior claims.
- Local browser checks now cover 27 assertions. The initial clean-checkout integration build passed; final publication preparation is checked separately before delivery.
- Final isolated Bun installation and build passed against the reference branch with the ordered patches. Its older source activates the snapshot guard, while all 41 explanations match the current local build.
- Ten provider-free tests passed with 89 assertions. The 27 browser checks passed again after the final integration, including the stale-snapshot path.
- Bound disclosure validation to the experiment ID so switching experiments cannot briefly reuse another record's matching status. Abort handling already prevents late responses from updating the next view.
- Added two browser assertions with a delayed metadata response to verify that a new experiment waits for its own audit match.
- Increased the atlas download and per-experiment atlas link to 44-pixel touch targets, preserving native keyboard behavior.
- Final browser run passed all 31 assertions across the standalone atlas and per-experiment disclosure. Local and isolated application builds both passed after the ID-bound validation change.
