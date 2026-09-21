# Design references for a playable Jev lab

The useful common pattern is a working object, a clear first action and an explanation beside the result. Jev should keep its scenes visually distinct while making source, uncertainty and recovery easy to inspect. This investigation reviewed brain function collapse plus five primary design-engineer sites on 2026-09-20 Pacific time. It collected eleven selected screenshots, all below 2 MB, and an [annotated visual reference board](reference-board.html). Screenshots establish what was visible, not animation quality, model accuracy or performance. The original [instrument notebook style study](style-study.html) turns the recommendations into a working visual artifact.

## Credit the original builders

| Work | Original builder and primary evidence | Relationship to this lab |
| --- | --- | --- |
| Laya model | [Nandakishor M / Convai Innovations](https://github.com/NandhaKishorM/laya), [weights](https://huggingface.co/convaiinnovations/laya), [Apache-2.0 license](https://github.com/NandhaKishorM/laya/blob/main/LICENSE) | Model architecture and local inference research precedent. Credit the model author separately from demo authors. |
| Laya playground, games, benchmark and agent skill | [Wojciech Dobry / brain function collapse](https://brainfunctioncollapse.com/laya/about), [original repository](https://github.com/wdobry/laya-playground), [MIT license](https://github.com/wdobry/laya-playground/blob/main/LICENSE) | Product and disclosure reference. Its repository explicitly says the public site replays recordings and local installation runs the model. |
| Shared-prefix, first-token scoring | [Eric Zhang](https://github.com/ekzhang), [openjev-sglang](https://github.com/ekzhang/openjev-sglang) | The existing MLX code cites inspiration from revision `604664a22b2cf44c6cc499e503092ae4e3c24c03`. It adapts the method; it does not port SGLang's CUDA runtime or reproduce its model performance. No license file appeared in the current primary repository listing; this research copied no source code. |
| Jev | [TypeSafe AI documentation](https://docs.typesafe.ai/) | Hosted model provider. This lab's UI, fixtures and conclusions are independent work. |

The Laya page's large speed headline is the page author's claim. Its detailed comparison separates local forward-pass timing from hosted HTTPS timing. Neither the headline nor the comparison is our reproduced result. Checkpoint names also matter: the primary model repository distinguishes a 421M English checkpoint and a 322M multilingual checkpoint. A blanket parameter count loses that distinction. [Laya source](https://github.com/NandhaKishorM/laya), [playground source](https://github.com/wdobry/laya-playground).

## What to borrow, and what to leave

### Wojciech Dobry

[See the Music](https://brainfunctioncollapse.com/projects/see-the-music) opens with a working composition, then breaks the signal path into smaller live figures beside the relevant code. Its restrained labels, large figure and single bright accent let the experiment carry the page. [Gradients](https://brainfunctioncollapse.com/projects/gradients) puts manipulable handles on the drawing and keeps exact numerical editing nearby. [Redraw](https://brainfunctioncollapse.com/projects/redraw-exploration) explores separating the draw command from pointer movement and labels its unstable WebGPU dependency as a technical preview.

**Jev application.** Keep the home scene large enough to play. Put the current decision next to the thing it affects. Material and brush rules should expose their existing direct controls alongside language input. Treat Redraw as interaction inspiration; do not add an unreleased subscriber library to this release. Its underlying renderer is credited to [William Candillon](https://wcandillon.dev/article/hello-project-redraw).

### Rauno Freiberg

[Invisible Details of Interaction Design](https://rauno.me/craft/interaction-design) studies interruptible movement, preserving spatial relationships and the cost of animation repeated hundreds of times. The [fractional slider](https://rauno.me/craft/fractional-slider) is a focused, working control with scale marks and one instruction. The broad craft gallery had partially unloaded media in this session, so the retained screenshot uses the working slider instead.

**Jev application.** Keep painting, game input and keyboard navigation immediate. Animate a branch thumbnail opening from its source, if motion is enabled, so users understand what was preserved. A touch brush preview should sit above the finger. Use existing Motion only when it improves that relationship; no animation library is needed for routine pressed states.

### Emil Kowalski

[Practical animation examples](https://emilkowal.ski/ui/7-practical-animation-tips) demonstrate pressed feedback, popovers that open from their trigger and faster repeated tooltip access. [You Don't Need Animations](https://emilkowal.ski/ui/you-dont-need-animations) provides a useful counterweight for frequent actions. [Sonner's source](https://github.com/emilkowalski/sonner) is a concrete MIT-licensed artifact, but a new toast dependency is unnecessary for this lab's existing status messages.

**Jev application.** Give save/export an immediate visible result. A modest press scale can help scene-start buttons; reduced motion should remove it. Keep cancellation visible during a request and preserve the input after failure. Avoid repeated page-entry transitions when the user switches between nearby experiments.

### Josh W. Comeau

[Springs and Bounces in Native CSS](https://www.joshwcomeau.com/animation/linear-timing-function/) puts playable side-by-side examples next to the explanation and examines interruption behavior. His [spring introduction](https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/) lets readers change one parameter at a time. These are executable explanatory artifacts, not just decorative illustrations.

**Jev application.** Show a router preference control beside the route it changes. Show two equal-state Tetris or crowd branches next to the one changed instruction. Let the user rerun a short comparison without scrolling back through setup. Adopt the explanatory structure with original implementation; this review did not establish a blanket license to copy article assets or snippets.

### Paco Coursey

[Paco's craft collection](https://paco.me/craft) organizes small implementations by behavior. His [exclusion tabs](https://paco.me/craft/tabs) demonstrate one selected indicator and explicitly credit Stripe's blog; the implementation uses a clipped duplicate presentation and marks the duplicate hidden from assistive technology. Clicking Engineering worked in this review. The [cmdk repository](https://github.com/dip/cmdk) now lives under `dip`; its history credits Paco's original implementation, Rauno's use and Shu's ideas. It carries MIT licensing.

**Jev application.** Give the scene picker a stable selected state. Avoid installing command-menu infrastructure for a handful of scene buttons. If the catalog later needs search, evaluate cmdk as a bounded component and retain the original author attribution despite the repository transfer.

### Maggie Appleton

The [garden](https://maggieappleton.com/garden) makes unfinished and mature work legible. Her [colophon](https://maggieappleton.com/colophon) explains the implementation and links [its source](https://github.com/MaggieAppleton/maggieappleton.com-V3). [Historical Trails](https://maggieappleton.com/historical-trails) argues for visible branching history and carefully credits earlier explorations. [Programming Portals](https://maggieappleton.com/programming-portals) places small, inspectable rules inside graphical tools.

**Jev application.** Separate playable scenes from research studies in navigation without hiding evidence. A branch should show its origin, changed parameter and recovery action. The custom material slot is already a small rule editor; show the typed rule Jev proposed and let users correct it. Preserve the control vocabulary rather than exposing arbitrary generated code.

## Concrete implementation priorities

These are recommendations from the review, not claims that all have shipped.

| Priority | Proposed change | Acceptance evidence |
| --- | --- | --- |
| Now | One working scene beneath the home invitation; scene names and one obvious first action | Desktop and 390 px screenshots; first interaction works without a key |
| Now | Source chip beside each live/recorded/local scene, with details on demand | Screenshot and inspected request showing the label agrees with execution |
| Now | Short button feedback and status text for save, export, reset and cancellation | Keyboard, touch and reduced-motion checks; errors preserve edits |
| Now | Builder credits linking model, playground and scoring method separately | Primary links above and existing MLX `THIRD_PARTY.md` |
| Next wave | Branch thumbnails that show the changed notice/rule and original checkpoint | Restore produces the saved state; pending work cannot apply after restore |
| Next wave | Touch preview above the brush/finger, plus exact value editing | Mobile play session; clear cursor and no page scroll while drawing |

## Original style study

Open [style-study.html](style-study.html) directly, or serve this folder with `python3 -m http.server 5204 --directory jev-experiments/roadmap/design-research` from the repository root. It has no external dependencies, model calls or network requests beyond loading the document. The illustration deliberately uses a few particle rules rather than claiming to reproduce the released materials engine.

The study defines light and dark color tokens, serif/sans/mono roles, a 4 px spacing scale, focus treatment and a 120 ms optional panel transition. Users can change direction and breeze, pause/reset, select or drag a grain, move it with arrow keys, inspect its state, open full screen and save a PNG. Reduced motion starts the illustration paused and removes transitions. Its source chip and inspector explicitly identify local rules and no model invocation.

Browser verification on 2026-09-20 used a separate Chromium session, `jev-design-research`:

| Check | Observed result |
| --- | --- |
| Desktop, 1440 × 1080 | Rule change, pause, selection, keyboard movement and inspector state worked. [Capture](output/playwright/style-study-desktop.webp) |
| Dark theme | The theme button changed canvas colors and controls. [Capture with selected grain](output/playwright/style-study-dark.webp) |
| Mobile, 390 × 844 | No horizontal overflow; direction controls and playback fit in the first viewport. Adjusted the caption background after spotting particles behind the label. [Capture](output/playwright/style-study-mobile.webp) |
| Reduced motion | After reload, Play was shown, the scene was paused and the panel duration was `0ms`. |
| Full screen | `document.fullscreenElement` became the scene. The explicit exit button returned to the page. |
| Save image | Browser downloaded `jev-grain-style-study.png`. |
| Reference board | Eleven attributed figures and no mobile horizontal overflow. |
| Console | The initial missing favicon request was fixed with an empty data icon; a fresh navigation showed no console errors. |

These are functional and visual spot checks. They are not a complete accessibility audit or measured frame-time result. Touch drag is implemented through pointer events but was not exercised on physical hardware.

## Local-model questions worth measuring

These are bounded research goals for the map. They do not expand the current public catalog.

- **Local rule interpretation.** Can a local typed model map varied material descriptions to the existing finite controls? Freeze paraphrase families and unsupported cases before calls. Measure exact rule agreement, unsupported rejection, option-order sensitivity, calibration and decision-level latency. Compare manual controls and a lexical baseline. Never generate executable simulation code.
- **Local semantic observation.** Can the same model interpret a resident notice or board outcome when code supplies quantities as explicit observations? Compare action framing with observation/outcome framing on matched states. Preserve arithmetic in code and test held-out wording. The Laya game page motivates the hypothesis; it does not prove the local model will generalize.
- **Local creative choice.** Can a small model choose among a fixed musical candidate set within continuity constraints? Preserve phrase locks and equal playback gain. Compare blinded preferences with procedural selections, separately from mechanical score validity.
- **Uncertainty that changes behavior.** Does a validation-calibrated abstention threshold improve successful task completion after including fallback latency and cost? Keep destination eligibility fixed between classifier conditions. A displayed probability alone does not establish useful calibration.

## Reuse and limits

No third-party source tree or copied implementation is included. The HTML reference board, style study and research notes are new work; screenshots are attributed study artifacts, not assets for Jev branding. Source-code licenses and website-artwork permissions are separate. This pass did not install libraries, run external benchmarks, train models, verify every source site's accessibility or measure animation frame times.

The materials, crowd and music changes began before this design review. Subsequent [materials refinement](../playable/materials-craft/README.md) put the palette above the canvas, added separate painting and inspection modes, preserved the scene's aspect ratio, and placed a touch preview above the finger. The homepage now combines an original serif invitation with that working scene. These are concrete applications of the research; the broader branch-thumbnail and local-model questions remain in the map.
