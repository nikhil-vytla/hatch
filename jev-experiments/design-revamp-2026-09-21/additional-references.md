# Additional references for experiment notes

The next version of Jev should give each experiment an authored point of view: what prompted it, what the reader can try, what the implementation does, and what changed our mind. Six additional references sharpen that direction. They extend the [earlier visual research](../roadmap/design-research/README.md), which already covers Wojciech Dobry, Rauno Freiberg, Emil Kowalski, Josh W. Comeau, Paco Coursey and Maggie Appleton.

Reviewed 2026-09-21. Observations below come from primary page text and, where noted, HTML structure. This pass did not exercise the controls in a browser or evaluate their accessibility, frame times or mobile behavior. Suggested applications and screenshot compositions are our interpretations, not findings about Jev's current implementation. No implementation or artwork was copied.

## Bartosz Ciechanowski: show the whole object, then explain one part

[Mechanical Watch](https://ciechanow.ski/mechanical-watch/) begins with instructions for rotating an assembled movement and exposing its interior. The article then separates power, gears and escapement before rebuilding the mechanism. It assigns consistent colors to named parts and offers a global animation pause. The HTML confirms individually addressable sections, including `#balance`; the text there introduces a time-scrubbing view with descriptions of successive mechanical events.

For Jev, let a working scene establish the subject before introducing its controls. A music note could isolate the transition between two phrases, then reconnect it to the accompaniment. Reuse the same color for a concept in the scene, explanation and code annotation. Borrow the sequence of explanations and choose rendering complexity to suit the subject.

## Bret Victor: let readers challenge the explanation

[Explorable Explanations](https://worrydream.com/ExplorableExplanations/) combines adjustable assumptions, prose that reflects their consequences, and linked representations of a filter. Its 2024 postscript distinguishes model-backed arguments from the broader category of interactive teaching articles. The HTML exposes `#reactiveDocument`, `#explorableExample` and `#filterExample`; these are useful capture targets. The page also explicitly labels its simplified policy calculation as invented, rather than presenting it as evidence.

For Jev, a routing note should state a bounded claim and let the reader vary its assumptions without losing the original case. Keep measured outcomes, the model of those outcomes and a hypothetical preference change visibly distinct. A frozen comparison can remain readable before the reader touches anything. Let the original case remain available for comparison.

## Nicky Case: explain a term without losing the sentence

[Nutshell](https://ncase.me/nutshell/) demonstrates expandable explanations inside the reading flow. Its documentation describes nested snippets, sentence recaps and embedding existing sections; it also warns against excessive nesting. The page credits Nicky Case and names contributors and earlier influences, including Ted Nelson's StretchText. Source inspection confirms the introductory demonstration is an iframe, so a capture must include its loaded contents. The [editable demonstration](https://ncase.me/nutshell/try/) is a separate page.

For Jev, a compact explanation of “option order” or “branch” could open beside the sentence that needs it. Keep the full technical note link available. Do not hide the central finding behind a chain of expansions. Existing disclosure controls can express this pattern without installing a new explanation framework.

## Matt Webb: retain the reason and the unfinished edge

Matt Webb's [Yesterday build note](https://interconnected.org/home/2026/08/26/yesterday) starts with a small personal need, shows the resulting weather app, and describes its visual vocabulary: today's solid line, yesterday's dashed line and arrows for the difference. It records limited everyday use and an omitted Fahrenheit option. The page's displayed publication date is 28 August 2026 even though the permalink contains `/08/26/`; cite the stable URL without inferring a date from it.

For Jev, write a short experiment note around an actual decision: why this scene exists, what surprised us, and what we would change next. Show a failed or incomplete result when it explains the next iteration. Personal judgment belongs in these notes; broad capability claims still need evidence.

## Jakub Krehel: make the implementation decision inspectable

Jakub Krehel's [Details that make interfaces feel better](https://jakub.kr/writing/details-that-make-interfaces-feel-better) pairs adjustable comparisons with nearby implementation snippets. Text wrapping, nested radii, numerical alignment and animation interruption each get a specific comparison. [The invisible side of design engineering](https://jakub.kr/writing/the-invisible-side-of-design-engineering) broadens the subject to hit areas, reduced motion, performance and localization. Those demonstrations are present in the page; their behavior was not tested in this pass.

For Jev, place a small, relevant code excerpt after the visible result it explains, followed by the tradeoff that led to it. Treat typography, target size and interrupted actions as part of the work. Select details that clarify the scene’s central behavior, and give its controls a consistent hierarchy.

## Amit Patel: connect the picture to code and its limits

Amit Patel's [Introduction to the A* Algorithm](https://www.redblobgames.com/pathfinding/a-star/introduction.html), published by Red Blob Games, starts with movable start and end points. It then explains the input representation, develops algorithms through short code changes and compares the resulting searches. The greedy-search section deliberately introduces an obstacle case where the appealing first result fails. Created/updated information and a companion implementation guide are visible. Its source provides stable section anchors including `#greedy-best-first` and `#astar`.

For Jev, explain exactly what a model observes and what ordinary code decides. A crowd comparison could place the resident's input beside its route; a material note could connect a rule to the few lines that implement it. Include a counterexample that exposes the method's limit, with a resettable preset that reproduces it.

## Capture brief for the visual review

This was the capture brief. The [completed visual study](references/README.md) records eight 1280 × 1000 captures from the first four sites, including exercised controls where noted. Krehel and Red Blob remain text/source research in this pass. The table preserves proposed compositions; it is not a claim that every proposed shot was captured. Keep the creator and nearby explanation visible. A still establishes composition; a before/after pair or short recording is needed to show a response to input. Retain attributed research figures, not assets to reuse in Jev branding.

| Priority | Exact page | Composition to capture |
| --- | --- | --- |
| 1 | [Mechanical Watch, opening](https://ciechanow.ski/mechanical-watch/) | Title, introductory instruction, assembled watch and its control. Follow with [Balance](https://ciechanow.ski/mechanical-watch/#balance) near the scrubbed mechanism and event explanation. |
| 1 | [Explorable filter](https://worrydream.com/ExplorableExplanations/#explorableExample) | Paragraph, editable parameter and connected figure together. Record a second state only after checking the control works. |
| 1 | [Nutshell](https://ncase.me/nutshell/) | Introductory demonstration with one explanation expanded; preserve the surrounding sentence. Avoid opening every nested term. |
| 1 | [Yesterday](https://interconnected.org/home/2026/08/26/yesterday) | Article premise and product image. A second crop should connect the image's line styles to the explanation. |
| 1 | [Krehel: concentric radii](https://jakub.kr/writing/details-that-make-interfaces-feel-better#concentric-border-radius) | Comparison, annotated values and adjustable controls in one frame. [Interruptibility](https://jakub.kr/writing/details-that-make-interfaces-feel-better#make-your-animations-interruptible) is a useful recording target. |
| 1 | [Red Blob: A* comparison](https://www.redblobgames.com/pathfinding/a-star/introduction.html#astar) | The three algorithm views with their labels and the adjacent code/explanation. Also inspect the counterexample in [greedy search](https://www.redblobgames.com/pathfinding/a-star/introduction.html#greedy-best-first). |

## Editorial decisions these references suggest

These are recommendations for the design pass, not additional release commitments.

1. Give an experiment one clear question and one inviting action. Its note should remain useful when the simulation is paused or cannot run.
2. Compose the page around its particular subject. A scored comparison, a playable world and a build diary need different figures and pacing, while sharing readable type, navigation and evidence conventions.
3. Keep an explanatory sequence: a concrete result, a controlled change, the part of the implementation that caused it, then the limitation or next question. Code should explain a visible decision.
4. Make revisions legible with a short dated learning and a reproducible scene or source reference. Keep detailed records available without making their file structure the first reading experience.

All linked works belong to their credited creators. These references inform original composition and interaction design; they do not grant a blanket license to reuse website artwork or source. The earlier report's functional acceptance checks still apply alongside this editorial direction.
