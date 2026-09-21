# Design review dispositions

[Fable 5.1 feedback](fable-feedback.md) came through OpenCode/AWS Bedrock. [Provenance](fable-provenance.json) records the exact requested and observed model, input hashes and scope. It reviewed source and screenshots without a browser. The final study differs from those input hashes because the findings below were addressed afterward. The root integrator verified consequential points in source, actual browser behavior and exported scenes.

The independent implementation reviewer also exercised the study in a separate browser. It caught the incorrect transformation caption, small mobile figures and indefinite loading when drawing fails. All three were corrected and checked again.

| Finding | Disposition and evidence |
| --- | --- |
| Replay/Start labels and button text used as state | Fixed. Initial action is Play from start; Reset returns to step 0 without playing. A boolean controls restart behavior. Browser verified play, pause, reset and keyboard scrubbing. |
| Mobile comparison too small | Added Larger figures, preserving the step and exposing expansion state. Browser measured 169 → 350 CSS px. Keep side-by-side as the initial comparison; a permanently stacked pair would separate the two outcomes and push the second below the first viewport. This is a deliberate choice, not adoption of the suggested default stacking. |
| Small-cell inset becomes noise | Fixed. The renderer omits the inset below 3 CSS px per cell and redraws on resize. |
| Rule labels disappear on narrow screens | Fixed. Labels stay visible below branch names on tablet/mobile. The earlier `water → wood` caption was separately corrected to `powder → wood`. |
| Dark theme waits for JavaScript | Fixed. CSS honors system dark preference before script execution. A JavaScript-disabled dark browser used `#171d19` paper and reported `color-scheme: dark`. |
| Theme button combines action and pressed-state semantics | Fixed. Kept the action label and removed `aria-pressed`. |
| Skip link lands before the experiment | Fixed. Its target is `#experiment`. |
| Incomplete or misleading legend | Fixed. Added stone and made all swatches square, matching the cell renderer. Names and counts provide additional context. |
| Drawing or missing build definition leaves permanent loading | Added a startup failure boundary and retry action. Null-context injection produced a visible error and no uncaught exception. Retained the required engine identity rather than enabling a partly initialized figure before provenance is available. |
| Playback could flood assistive announcements | Set the output to `aria-live="off"`, added range `aria-valuetext` and moved status updates from continuous input to committed changes. Browser inspected these attributes; actual screen-reader behavior remains unverified. |
| Code's accessible name may be ignored | Added a named region to the keyboard-focusable code scroller. Screen-reader operation remains a release check. |
| No fall before the first contact | Fixed the starting scene. Exported step-0 scenes have identical cells and seed, no initial wood, and first produce wood at step 13 when run through the engine. The default is step 24. |
| Omitted map context and water's role | Caption now explains the name-to-ID maps and states that only powder changes. Actual exports retain 1,188 water cells in each branch at step 96. |
| Missing authorship/revision metadata | Added the project source, actual authoring/review tools and a dated revision note. No personal byline or anecdote was invented. Kept Figure 01 as a figure number within this page; removed the implied series number from the page metadata. |
| Narrower reading column and larger metadata | Reduced the prose column to 600 px, aligned body line height to 1.65 and raised metadata/code labels to at least 12 px. Final mobile and reading captures were inspected. |
| Focus differs from the design accent | Retained the amber focus outline so focus can be distinguished from green selection. Recorded the exception in DESIGN.md. |
| Many optical spacing values | Retained the reviewed composition. A 4 px base guides the layout but does not require every typographic adjustment to be divisible by four. Reassess shared spacing when integrating actual app pages. |
| Snapshot memory / alternate-font behavior | Deferred performance changes until profiling. The current page retains one bounded comparison, with no claim about sustained memory performance. Android/Linux font rendering still needs a real platform check before release. |

The review supported the large working figure, restrained grouping, real engine excerpt and explicit model/physics limits. Those remain. It did not establish accessibility certification, model quality, application adoption or release readiness.
