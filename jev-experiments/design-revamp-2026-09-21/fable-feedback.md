I'll start by listing the working directory to find the files referenced.

Now the screenshots and the remaining files.

# Review: Jev design direction and "A grain meets water" study

Scope: read-only review of `DESIGN.md`, `editorial-study.{html,css,ts}`, `engine.ts`, both reference documents and the two screenshots. No browser, so interaction, focus, screen-reader and reduced-motion behaviour are assessed from source only. `stderr.log` is empty and `events.jsonl` is this review session's own log; neither contains study evidence.

## Verdict

The study is a credible realisation of the direction: one question, one full-width instrument, an honest note with a real code excerpt, small dependencies. The desktop composition works. The consequential problems are (1) the transport control labels contradict each other, (2) the mobile branch grid makes the subject unreadable, (3) the `<output>`/status updates are likely to be noisy for assistive tech during playback, and (4) the note's central sentence describes a moment the reader cannot actually see because the grains already touch the water at step 0.

## Worth keeping

- The page skeleton: meta line → serif title → hairline → instrument → caption → margin-note + prose → colophon. Grouping by rules and alignment, borders only on canvas and code (`editorial-study.css:33,42,69`), matches `DESIGN.md:29`.
- Precomputed paired snapshots and a scrubbable range (`editorial-study.ts:32-36,96`). This gives reduced-motion users a meaningful static state plus explicit playback, with no autoplay (`ts:14,132`), and scrubbing interrupts playback (`ts:96`), as `DESIGN.md:54-55` asks.
- Hidden-tab and pagehide pauses (`ts:127-128`).
- The code excerpt is a faithful copy of `engine.ts:179-186` with the caption stating what was adjusted (`html:57-66`). The `details` block that says the model decides nothing here (`html:67`) and the "not a physics claim" section (`html:68-70`) are exactly the honesty `DESIGN.md:76` wants. The RNG-divergence caveat (`html:69`) is correct: the contact branch `continue`s before `random()` is called (`engine.ts:184-185,217`).
- Grain counts reconcile (148 = 126 + 22 in the desktop capture), and the per-branch `aria-label` is updated with real numbers (`ts:68-69`).
- Native `<input type="range">`, `<button>`, `<details>` throughout; 44 px minimums on buttons, range, text buttons (`css:10,49,57`).
- Exact footer text present (`html:77`); execution label `Local rules · no model call` matches `DESIGN.md:21`.

## Verified defects (source or screenshot)

1. **Transport labels contradict their actions.** The primary button reads "Replay" before anything has played (`html:29`), and the reset button reads "Start" (`html:31`) but only jumps to step 0 without playing (`ts:97`). A first-time reader who presses "Start" gets a still frame; "Replay" is what actually starts. The code also uses the button's text as state (`ts:90`). Fix: primary "Play" (becomes "Pause"/"Replay" as now), secondary "Reset" or "Step 0"; track `hasPlayed` in a variable, not the label.

2. **Mobile branch grid defeats the subject.** `.branch-grid` stays two-column at ≤540 px (`css:37`, no override at `css:100-140`). In `mobile.webp` each canvas is roughly 167 × 111 CSS px, so 96 cells render at about 1.7 px each and the 0.7 px cell inset (`ts:53`) becomes sub-pixel noise; the water reads as a blurred block and the 22 wood cells are barely distinguishable. This is the page's one figure, and `DESIGN.md:19` requires the first useful action to work at 390 × 844. Fix: stack the branches full-width on narrow screens, or offer an A/B segmented toggle over one full-width canvas, and drop the inset below a pixel threshold.

3. **The rule labels vanish on tablets and phones.** `.rule-label` (`contact: none`, `water → wood`) is `display:none` at ≤760 px (`css:98`). That is the only place the changed parameter is stated beside the figure. Move it under the branch name instead of hiding it.

4. **Dark mode depends on JavaScript and flashes light.** `:root` is `color-scheme: light` and the dark palette exists only under `[data-theme="dark"]` (`css:1-2`); the theme is applied at `ts:129` after snapshot computation. A dark-preference visitor sees a light page first, and with JS off never gets dark. Add a `@media (prefers-color-scheme: dark)` block for `:root:not([data-theme="light"])`.

5. **Theme toggle mixes two toggle idioms.** The label flips "Dark"/"Light" *and* `aria-pressed` flips, with an `aria-label` describing the action (`ts:120-122`). A screen reader gets "Use light theme, pressed". Use either a constant label with `aria-pressed`, or an action label without it.

6. **Skip link target mismatch.** "Skip to the experiment" points to `#main` (`html:13`), which begins with the meta line and title; `#experiment` exists (`html:26`).

7. **Legend omits stone; legend shapes do not match rendering.** Grey stone walls and floor are visible in both captures but absent from `html:45`. Circle/square/diamond swatches (`css:54-56`) imply shape coding the canvas does not have (`ts:53` draws squares only).

8. **Fragile initialisation order.** `ENGINE_SHA` is used at `ts:130` before controls are re-enabled at `ts:131`. If the build ever omits the define, the page stays permanently disabled with "Preparing a deterministic comparison." Enable controls first, or guard with `typeof ENGINE_SHA`.

## Likely issues needing a browser or AT check (not verified)

- `<output id="tick-value">` (`html:30`) has an implicit `status` role and is rewritten every ~65 ms during playback (`ts:71,80`). Screen readers commonly announce `output` changes; expect a stream of "25 / 96 steps, 26 / 96 steps…". Similarly `role="status"` text is rewritten on every range `input` event (`ts:96`). Suggest `aria-live="off"` on the output while playing, `aria-valuetext` on the range, and status updates only on discrete actions.
- `aria-label` on a `<pre tabindex="0">` (`html:57`) may be ignored without a role; `role="region"` would make it a named scrollable landmark.
- Georgia is not present on Android/Linux; the title's `-.05em` tracking (`css:28`) is tuned for it. Check the Times/Noto fallback before promoting the type decision in `DESIGN.md:33`.
- Memory: 97 × 2 full `Scene` clones including unused `ages` arrays (`ts:32-36`) is roughly 2.4 M numbers. Fine for one page; if the pattern is promoted, snapshot `Uint8Array` cells and re-simulate for export.

## Explanation accuracy

The engine description is accurate (scan alternation `engine.ts:168`, four-neighbour check `173-178`, `set` resetting age and marking moved `161-165`, material 7 as the custom slot). Two gaps:

- **The grains already touch the water at step 0.** The column is painted at `y = 15..42` with radius 2 (`ts:26`), so its lowest cell is `y = 44`; water starts at `y = 45` (`ts:24`). In branch B the first wood appears at step 1, and the note's "Watch the purple grains reach the pool" (`html:55`) describes an event the reader cannot observe. Lift the column (e.g. `y = 5..30`) so a visible fall precedes contact, and set the default tick just after first contact rather than 24.
- The excerpt uses `contacts[...]` and `ids[...]` without saying they are module-level maps (`engine.ts:64-72`). `DESIGN.md:74` asks for omitted context to be labelled; one clause in the caption suffices. Worth adding too: the rule transforms only the custom particle and leaves the water intact, which is a deliberate engine constraint (`engine.ts:286`) and is the real authored decision behind the shelf that forms.

## Authorship and writing

The tone is good, but there is no byline, builder credit or revision line in "Behind this note" (`html:75`), which `DESIGN.md:70` lists as part of a note. "Material studies / 01" and "Figure 01" imply a series that does not exist; harmless in a study, but avoid numbering as a promise. The `Next question` block is the strongest authored element; one sentence about *why* this rule was the first one chosen would complete the sequence in `DESIGN.md:64-70`.

## Taste and composition suggestions

- Prose column is 660 px at 17 px (`css:62`), about 75 characters; `DESIGN.md:40` says ~62. Try 580–600 px.
- Several mobile sizes drop to 10 px (`css:107,119,123,124`). Contrast is adequate (~5.7:1 muted on paper), but the reference notes explicitly warn against importing small type. Floor at 12 px.
- Focus colour is an orange (`--focus`, `css:1`) while `DESIGN.md:38` says focus and selection share the accent. Either is defensible; record it as a deliberate exception.
- At the default step 24 the upper half of each canvas is empty field. Repositioning the source (see above) also fixes this.
- Spacing uses many one-off values (21, 35, 38, 17, 19, 9 px). `DESIGN.md:41` allows optical adjustment, but this many suggests the 4 px base is nominal.

## Notes on DESIGN.md

Coherent and appropriately cautious about what is not yet done. Two small corrections: the body line-height token is 1.65 (`DESIGN.md:34`) while the study uses 1.6 (`css:1`); and the reading-measure token does not match the study's 660 px column. The document correctly frames the study as a trial and does not claim release readiness; nothing in the reviewed materials supports drawing release or model-quality conclusions, and this review does not.

## Concrete change list

1. Rename transport buttons; replace text-as-state with a flag.
2. Stack or toggle branches below 540 px; remove the cell inset when cells are under ~3 px.
3. Keep `.rule-label` visible at all widths.
4. Add a `prefers-color-scheme: dark` CSS fallback.
5. Fix theme-toggle ARIA; fix skip-link target; add stone to legend and use square swatches.
6. Move the grain column higher and choose a default tick just after first contact; edit the "reach the pool" sentence accordingly.
7. Note `contacts`/`ids` in the code caption and state that water is not consumed.
8. Silence `output` and status during playback; add `aria-valuetext`.
9. Enable controls before using `ENGINE_SHA`.
10. Add byline, credits and a revision line to the colophon.
