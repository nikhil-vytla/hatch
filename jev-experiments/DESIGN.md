# Designing Jev experiments

Jev should feel like a place where someone builds, plays and pays attention. A visitor can make something happen before reading the explanation. A curious reader can keep going until they reach the rule, the code and the evidence. The craft should be visible in both experiences.

This is the design direction for the first public release, not a claim that the current site already meets it. The [release decision](design-revamp-2026-09-21/ui-ux-release.md) tracks adoption. The [working editorial study](design-revamp-2026-09-21/editorial-study.html) tests one proposed page with the existing materials engine. The [reference board](design-revamp-2026-09-21/reference-board.html) documents its influences.

## Point of view

The site is an instrument notebook. Its subjects are material rules, games, music and small decisions. Give these subjects the visual character. A falling grain, a held chord or a changed route is more interesting than a decorative dashboard around it.

Taste means choosing what deserves attention. Each page gets a specific question, a useful default and an obvious first action. Cut a panel when its text could appear unchanged on five other experiments. Leave room around the thing the reader came to try. Spend the saved space on a revealing comparison or an honest account of something that failed.

The notebook also has an author. Experiment notes may contain judgment, unfinished thoughts and changes of mind. They must describe work that happened. Do not invent a personal anecdote, an audience reaction or a successful result to make a page warmer.

## Pages and navigation

Use **Play**, **Notes** and **About** as the primary destinations. Keep the complete catalog searchable from Play. Notes lead to working scenes; scenes link to their own implementation notes. About contains the colophon, builder credits and the distinction between this independent lab and its model providers.

The homepage opens with a usable scene and a short invitation. Its first useful action should fit at 390 × 844 as well as on desktop. Follow it with a small selection of finished experiments and recent notes. An exhaustive grid belongs farther down the page. Do not use the number of experiments as the main promise.

A scene page has one title and one question. Put its input and immediate consequence together. Use a compact, accurate execution label such as `Local rules`, `Recorded run` or `Live · provider/model`. An inspector can hold the full request, distribution and timings. Keep errors and required setup visible without opening it.

Remove the repeated question, generic introduction and generic comparison panels in the current shared detail wrapper. Layout variants that exist only to demonstrate layouts can leave the public experience. Keep the underlying records and reproducible links that have research value.

Avoid a universal page grid for all scenes. Music needs a keyboard and a phrase timeline. Tetris needs a board, a queue and a handoff. Crowd needs a square and a selected resident. Share navigation, typography, controls and disclosure conventions; keep these compositions specific.

## Visual direction

Use a quiet paper background, dark green-black type and crisp figures. The reading column is narrow; a scene can step outside it. Fine rules and alignment should do most of the grouping. Reserve a container border for something that is actually a separate object, such as a canvas, editable field or code listing. Avoid card grids inside card grids.

| Role | Starting decision | Reason |
| --- | --- | --- |
| Editorial type | Georgia or a comparable licensed text serif for article titles and occasional emphasis | Gives notes a reading rhythm distinct from controls. No decorative serif on every label. |
| Interface and body | Existing DM Sans where already loaded; system sans fallback | Preserve legibility during font loading. Body starts at 17 px, with about 1.65 line height. |
| Code and measurements | Existing IBM Plex Mono; system monospace fallback | Use tabular numbers for changing counts. Keep units visible. |
| Paper / ink | Light `#f5f4ef` / `#242c27`; dark `#171d19` / `#eceee6` | Use authored dark colors, including scene labels and syntax colors. |
| Secondary text | Light `#596259`; dark `#adb9ac` | Metadata remains readable; do not make it faint to establish hierarchy. |
| Interface accent | Light `#24634c`; dark `#a0cbb2` | Selected controls share a recognizable treatment. Use a separate amber focus outline so keyboard position stays distinct from selection. |
| Scene color | Chosen for the subject; accompanied by shape, text or position | Sand, water, branch differences and musical voices need their own meanings. |
| Reading measure | About 62 characters; figures up to 1120 px | Text and tools have different space requirements. |
| Spacing and edges | 4 px base, optical adjustments allowed; small radii on controls | Consistent rhythm without rounding every object into a pill. |

These are starting tokens, not a reason to preserve a weak composition. The editorial study deliberately uses system fonts so the direction can be reviewed without a font service. Verify contrast at actual sizes, including code, focus and disabled states, before promoting tokens into the application.

Use imagery made by the experiment: a saved scene, a score, a route or a comparison. Do not add stock abstractions, grain overlays, glowing gradients or unrelated animated ornaments to make a sparse page appear designed. A screenshot has a caption naming the state it records.

## Interaction is part of the explanation

- Keep direct manipulation immediate. Model work can shape a future state; it must not delay a piano key, brush stroke or game input.
- Preserve the starting case when a reader changes an assumption. A branch states its origin and changed input. Draw a relevant difference in the scene before showing aggregate scores.
- Put an explanation near the selected object. A short expansion may define a term or show a decision; do not hide the central finding in nested disclosures.
- Every drag action has a labelled keyboard control or an equivalent action. Pointer targets are at least 44 × 44 CSS px. Focus remains visible and returns to the trigger when an inspector closes.
- Give reset, save, export, cancellation and failure concrete visible outcomes. Preserve edits on recoverable errors. A stale response cannot apply after reset, edit, branch or unmount.
- Let animations be interrupted. Use movement to show where an object came from or what changed. Frequent operations should not wait for a transition. Start with 120–180 ms for occasional interface transitions, then judge them in use.
- Respect reduced motion through meaningful static states and explicit playback. Remove decorative movement and smooth scrolling. Keep a step/scrub option when motion is necessary to understand a simulation.
- Pause hidden simulations and release listeners, audio and animation frames on unmount. Profile the active scene before adding rendering infrastructure.

Do not import a reference site's accessibility weaknesses. A beautiful tiny drag handle is still a poor touch control. Browser emulation is useful evidence, but does not replace a physical phone or assistive-technology check.

## Writing an experiment note

A note earns its space by explaining a real choice. Use the title to name the subject or question. Follow it with enough context to understand the figure, then let the reader try the case.

A useful sequence is:

1. The question and the original constraint.
2. A resettable example with its execution mode identified.
3. The particular implementation decision that produces the visible behavior.
4. What the observed result supports, a counterexample or limitation, and the next question.
5. The relevant source, protocol, result artifact and builder credits.

This is an editing aid, not five mandatory section headings. A short build note may need four paragraphs. A training study needs methods, coverage and tables. Do not inflate either into a generic article template.

Code excerpts should be short enough to explain one visible behavior. Link the complete source and the revision used; label omitted context and pseudocode. Use selectable text with a language label, readable syntax colors and a copy action. On narrow screens, wrap prose and scroll code inside its own region. A pasted code block must not contain line-number artifacts.

Keep claims beside their evidence. Label measured results, model-based simulations and illustrative examples in plain language. Include validation/test boundaries, coverage and failed conditions where they change the conclusion. A hypothetical router saving is hypothetical even if the control that produced it feels convincing.

Date substantive revisions and explain what changed. Preserve a past result when a new implementation changes it. Do not generate a stream of posts merely to make the site look active.

### First notes worth writing

| Note | Concrete material already available | What still needs editorial work |
| --- | --- | --- |
| A grain meets water | Deterministic material engine, typed custom rule, matched branches | Working design study now; integrate the note with the public sandbox and its source revision. |
| Keeping a phrase while changing the accompaniment | Phrase locks, boundary scheduling, saved scores | Annotated audible before/after example and the continuity constraint that matters. |
| What one resident saw | Notice edits, individual observations, matched routes | A reproducible notice pair with the selected resident and changed route visible. |
| When the router declines | Hard eligibility, real delegation traces, recorded outcomes | One complete task story, including overhead and a useful failure. |
| The local default is still experimental | Three-seed training study, validation selection, export comparisons | A readable account of the weak results and why the default was selected. |

## Reference decisions and credit

The [earlier study](roadmap/design-research/README.md) and [additional research](design-revamp-2026-09-21/additional-references.md) retain the source-specific observations. The new captures distinguish an exercised control from a static article or product screenshot. They are research references, not assets for Jev branding.

| Builder / work | Decision it informs |
| --- | --- |
| [Wojciech Dobry, brain function collapse](https://brainfunctioncollapse.com/projects/see-the-music) | A working composition and code can share the explanation. Keep the artifact large. |
| [Bartosz Ciechanowski, Mechanical Watch](https://ciechanow.ski/mechanical-watch/) | Establish the whole object, then reveal a part without losing its context. |
| [Bret Victor, Explorable Explanations](https://worrydream.com/ExplorableExplanations/) | Let a reader vary an assumption and see the linked consequences. Label invented examples. |
| [Amit Patel, Red Blob Games](https://www.redblobgames.com/pathfinding/a-star/introduction.html) | Connect the picture, input representation and code. Include a case where a tempting method fails. |
| [Nicky Case, Nutshell](https://ncase.me/nutshell/) | Explain a term in place; keep nesting shallow and credit earlier ideas. |
| [Matt Webb, Yesterday](https://interconnected.org/home/2026/08/26/yesterday) | Keep the reason for building something and its unfinished edge in the writing. |
| [Jakub Krehel, interface details](https://jakub.kr/writing/details-that-make-interfaces-feel-better) | Put a specific visible comparison beside the code that explains it. |
| [Rauno Freiberg, interaction design](https://rauno.me/craft/interaction-design) | Preserve spatial relationships and make interruption feel deliberate. |
| [Emil Kowalski, You Don't Need Animations](https://emilkowal.ski/ui/you-dont-need-animations) | Repeated actions benefit from restraint. |
| [Josh W. Comeau, springs in CSS](https://www.joshwcomeau.com/animation/linear-timing-function/) | Isolate a parameter in a playable figure. |
| [Paco Coursey, tabs](https://paco.me/craft/tabs) | A selected state can be distinctive while remaining obvious. |
| [Maggie Appleton, garden](https://maggieappleton.com/garden) | Show maturity, revision and provenance as part of authorship. |

Model and implementation credits are separate from visual influences. Credit **Nandakishor M / Convai Innovations** for the [Laya model](https://github.com/NandhaKishorM/laya), **Wojciech Dobry** for the [Laya playground](https://github.com/wdobry/laya-playground), and **Eric Zhang** for the shared-prefix, first-token scoring method in [openjev-sglang](https://github.com/ekzhang/openjev-sglang). The MLX work adapts that method; it is not a port of SGLang's CUDA runtime. Record the source revision and license when adapting code. A repository's code license does not establish permission to reuse every illustration on its author's website.

Keep this exact footer text: **Not affiliated with or endorsed by TypeSafe AI**.

## Adoption and release gate

| Work | Status on 2026-09-21 | Completion evidence |
| --- | --- | --- |
| Reference research and art direction | Authored; twelve builders across two studies | Cited observations, eight new captures and the reference board. |
| Editorial page and material comparison | Working design study; outside the public catalog | Browser checks and design review recorded in the study report. |
| Shared navigation, typography and page composition | Open; first-release requirement | Homepage plus materials, music, Tetris, crowd and routing reviewed together. |
| Experiment notes | First working example; remaining notes open | Real sources, executable figures, accurate code and revision metadata. |
| Whole-site usability and visual review | Open | Desktop/mobile, keyboard, dark mode, reduced motion, recovery and active frame-time evidence. |
| Canonical deployment | Open | Reviewed code applied on main and deployed by the existing Vercel project. |

The root integrator owns this file and coherent site composition. Scene owners own their interaction details. Review duplication after every two integrations, and record both shared extractions and deliberate exceptions. Existing Tone.js, Three.js, Motion, React Flow and native browser controls are the starting tools. Do not create a universal experiment engine or add a new UI library merely to implement this direction.

The release review should use real pages, short interaction recordings and source-linked claims. Fable 5.1 feedback is advisory: record its findings and our dispositions, then verify consequential points independently. Research depth and visual polish both matter. A completed design document does not close the UI/UX release gate.

## Decision log

- **2026-09-21, accepted:** UI/UX includes art direction, interaction engineering and authored experiment writing, and belongs before the first public release. Backward compatibility does not constrain the redesign.
- **2026-09-21, accepted:** retain the instrument-notebook direction but replace repeated generic wrappers with subject-specific compositions. Share a small set of readable tokens and controls.
- **2026-09-21, trial:** use the materials comparison to test wider figures, a quieter shell and code beside the observation it explains. Promote the pattern after review; keep layout choices specific to each subject.
- **2026-09-21, reviewed:** Fable 5.1 supported the composition and identified control, small-screen and explanation details. [Dispositions](design-revamp-2026-09-21/review-dispositions.md) separate corrections, retained choices and remaining checks. The study keeps a distinct amber focus outline, a 600 px reading column and a 12 px minimum for metadata.
