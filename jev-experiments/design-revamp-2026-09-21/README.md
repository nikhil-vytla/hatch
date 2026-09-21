# A more authored Jev

Jev's UI/UX revamp includes art direction, interaction engineering and experiment writing. [DESIGN.md](../DESIGN.md) records that direction, its reference decisions and the open adoption work. This folder adds six primary references to the earlier six-builder study, an [interactive reference board](reference-board.html), eight attributed captures and a [working editorial page](editorial-study.html) using the existing materials engine.

The direction is an instrument notebook: a quiet reading layout, generous figures, controls beside their consequences and code that explains a visible result. Each scene keeps its own composition. Music should feel like an instrument, crowd like a place, and a material rule like something that can be handled and inspected.

## Explore the work

- [Reference board](reference-board.html): eight captures, paired state controls, creator links and a twelve-builder index.
- [A grain meets water](editorial-study.html): matched branches, time scrubbing, replay, mobile enlargement, scene export and a source-linked implementation note.
- [Additional references](additional-references.md): Ciechanowski, Victor, Case, Webb, Krehel and Patel, with specific observations and proposed uses.
- [Capture manifest](references/manifest.json): sources, states, dimensions and hashes. Four sites received visual study; the remaining two are text/source research in this pass.
- [UI/UX release decision](ui-ux-release.md): scope, ownership, dependencies and a separate implementation checklist.

The earlier study remains useful, particularly [Wojciech Dobry's work](https://brainfunctioncollapse.com/projects/see-the-music) on figures and code, Rauno Freiberg on interruption, Emil Kowalski on restrained motion and Maggie Appleton on authorship and revision. The new work strengthens the connection between a working experiment and its written account. [Amit Patel's A* explanation](https://www.redblobgames.com/pathfinding/a-star/introduction.html) is a useful precedent for connecting the input, picture, code and counterexample.

## Run the editorial study

From the repository root:

```sh
bun run jev-experiments/design-revamp-2026-09-21/build.ts
python3 -m http.server 5217 --bind 127.0.0.1 --directory jev-experiments
```

Open `http://127.0.0.1:5217/design-revamp-2026-09-21/editorial-study.html`. The reference board is beside it. The Bun build needs no dependency installation and generates an ignored `study.js`. It bundles the existing engine and embeds its SHA-256. No third-party renderer or simulation source was copied into this folder.

The two scenes share their initial cells and seed. Branch A disables contact; branch B turns custom powder into wood when it touches water. All 97 steps are computed locally and retained for scrubbing. Each exported `branches` entry is accepted by the existing materials scene parser. This is a grid-rule demonstration, not a model evaluation or physical simulation claim.

## Verification

Isolated Chromium checks ran on 2026-09-21. [verification.json](verification.json) records the bounded results.

| Check | Result |
| --- | --- |
| Build and strict TypeScript | Passed; no dependency changes. |
| 1440 × 1080 and 390 × 844 | First action visible, no horizontal overflow; desktop, mobile, dark and reading views inspected. |
| Keyboard time control | Home restored step 0; ArrowRight advanced to 1; End reached 96. Focus visible. |
| Playback and reset | Play from start advanced both branches; pause held its step; Reset restored both initial states. |
| Mobile enlargement | Figures expanded from 169 to 350 CSS px, with step preserved and `aria-expanded` updated. |
| Export | Real JSON download; both states passed `parseScene`, with contacts `none` and `water`. |
| Explanation and code | Disclosure opened in place; Copy completed. Excerpt checked against the engine. |
| Dark / reduced motion | Authored dark palette, no autoplay, zero-duration button transitions. Delivered motion-preference change paused playback in independent review. |
| Drawing unavailable | Injected null canvas context produced a message, retry button and readable note, with no uncaught page error. |
| JavaScript disabled | Note, source links and explicit fallback remained readable; CSS system dark theme worked. |
| Reference board | Four paired controls, original-image links, keyboard operation, themes and 390 px layout passed. |

These are spot checks. Phone hardware, screen-reader operation and sustained frame-time measurement remain release work. Hidden-page cancellation is present in source but was not verified through an actual hidden document in this browser session.

Fable 5.1 reviewed the direction, source and screenshots through OpenCode/AWS Bedrock. Its [feedback](fable-feedback.md), [verified model identity and input hashes](fable-provenance.json), and [finding-by-finding dispositions](review-dispositions.md) are retained. Independent checks confirmed the contact first occurs at step 13, the starting cells and seed match, and water is conserved in these particular exported examples. Neither review establishes general model or simulation quality.

Selected views: [desktop](output/playwright/editorial-desktop.webp), [mobile](output/playwright/editorial-mobile.webp), [dark mobile](output/playwright/editorial-mobile-dark.webp), [implementation note](output/playwright/editorial-note.webp). All selected binaries are below 2 MB. Reference screenshots credit their creators and are retained for analysis, not Jev branding assets.

## Adoption

The application has not adopted this sitewide direction yet. Its shared wrapper needs the repeated question and generic panels removed, followed by a coherent pass across the home, materials, music, Tetris, crowd and routing. Notes need real sources and observations, not placeholder posts. [DESIGN.md](../DESIGN.md) and the release decision track that work.

Existing roadmap changes are supplied as [roadmap-update.patch](roadmap-update.patch), following the repository's research convention. Apply it from the repository root with `git apply --check` and then `git apply`. It places design and authored notes in the first-release gate and links the named decision. The application root and deployment configuration are unchanged.

The requested footer appears verbatim in the study. The earlier application patch also contains it and the separate Laya/model/playground/scoring-method credits. This delivery does not claim those pending application changes are deployed.
