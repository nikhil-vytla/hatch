# Fable review dispositions

The [reviewed source commit](https://github.com/nikhil-vytla/hatch/tree/23e5a026985c73829457e30604f70067999986e9/jev-experiments/capability-atlas-2026-09-22) and the retained reviewed screenshots preserve the input snapshot.

The root independently checked the [Fable 5.1 Global findings](fable-feedback.md) against the source. The [review provenance](fable-provenance.json) identifies the reviewed snapshot. Corrections below happened after that review; Fable has not reviewed their final implementation.

| Finding | Disposition and evidence |
| --- | --- |
| 1. Missing question counts | Confirmed and fixed. `build-atlas.py` now derives `count_note` for every authored question shape. `verify.py` rejects an empty note for any record. Specific counts and batch sizes remain visible; descriptive question labels retain their experiment-specific meaning. |
| 2. Rejection versus silent loss | Confirmed and fixed in the headline and structured-question essay. Hosted wrapper rejection and shared/Mac criteria loss are separate behaviors. The provider-free probes establish both. |
| 3. Mobile comparison | The content was horizontally scrollable, so it was not lost. The screenshot did conceal the end of long lines without a visible scroll cue. Accepted the readability recommendation: examples now wrap, and a mobile browser assertion verifies that their full lines fit. |
| 4. Missing execution modes | Confirmed and fixed. The inspector now displays the same available execution paths as the atlas. Retained specific descriptions because an experiment can have several paths with different evidence; a single recorded/live/local badge would flatten that distinction. |
| 5. Source guard scope and stale metadata | Confirmed the cache gap in the full pipeline. Preparation now hashes the audit and observed source into a build ID, Vite embeds it in the app bundle, and the inspector requires matching metadata with caching disabled. A browser check rejects another build's metadata even when its date and record flag agree. Common gateway/runtime adapters are now explicit source bindings. The report states that this verifies listed source identity, not every prose claim. |
| 6. Smaller implementation notes | Removed the hardcoded catalog count, consolidated announcements into one live region, aligned inspector focus colors with the atlas themes, and removed the redundant checking-state update. Kept the small reduced-motion rule as a local CSS constraint; the visual currently has no animation. |
| 7. Unprovided references | Preserved the review's limitation. The reviewer did not receive the full app or probe inputs. Root and the separate runtime audit checked those references and ran the probes; the review is not presented as independent confirmation of all 136 call-site references. |

The shared atlas remains the only explanation data source for both views. Simulation state, inference and evaluation stay in their existing experiments. No general experiment engine, inference framework or new package dependency was added.

[Browser checks](browser-checks.json), [provider-free tests](prepare-atlas.test.ts), [runtime probes](runtime-probe-results.json), [clean-build evidence](clean-build.json) and [artifact verification](verification.json) record the relevant checks. No new model-quality measurements were made.
