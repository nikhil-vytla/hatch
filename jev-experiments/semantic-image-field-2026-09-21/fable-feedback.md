I'll start by surveying the working directory.

Now the screenshots.

# Review: Jev field view (semantic-image-field integration)

Scope: `image-field.tsx`, `field-layout.ts`, `image-field.css`, `visual-search.tsx/.css`, `collection.ts`, two screenshots, `DESIGN.md`, `reference-analysis.md`. Read-only; no runtime, keyboard, screen-reader, contrast or frame-time verification was possible. Nothing below says anything about retrieval quality — the field changes presentation of existing text rankings only.

## Verdict

Tidy, but not good yet. The tokens, execution labels ("Recorded Jev · museum text"), and research copy match DESIGN.md well. The field itself does not earn its place as the **default** view: uniform 140×170 bordered cards in square rings read as a scrambled grid inside a box. Rank is only legible by reading "#N" labels; the scan order is not intuitive; ~10 of 36 visible desktop cards are "Image preview unavailable" glyphs, so the chrome dominates the art. The Grid view has larger images, serif titles, scores and the caption-vs-metadata rank shift — it is the richer, more honest presentation, and the field drops all of that. The reference's point (relevance legible at a glance) was traded away for camera mechanics.

## Verified defects (from source or visible evidence)

1. **Silent render cap leaves holes when zoomed out.** `FIELD_RENDER_LIMIT = 72` (`field-layout.ts:18`, enforced `:131–135`). 204 works fill a 15×15 ring block (~2460×2910 world px). At `FIELD_MIN_ZOOM` 0.45 in a ~1300×700 viewport, roughly 120 cards fall inside the view but only the 72 nearest the center render — the periphery is blank paper with no "N more not drawn" indicator. Overview mode is exactly when a user is trying to see the whole population. Culling 204 absolutely-positioned buttons is also rendering infrastructure DESIGN.md says to profile before adding (line 56).

2. **Focus styling contradicts DESIGN.md and is in a specificity tie.** `image-field.css:29–30` set focus outlines to `--vs-accent` (green), the same color as the active/hover ring (`:14–15`). DESIGN.md line 38 requires a separate amber focus outline so keyboard position is distinct from selection. `visual-search.css:32–35` applies amber at equal specificity (0,2,1); `.vs-field-card:focus-visible` (0,2,0) always loses. Whichever wins is wrong: green → focus indistinguishable from selection; amber → a fixed 2px/4px outline drawn inside the scaled plane (0.9px at min zoom, 5px at max), and the `--vs-field-outline` compensation is dead code.

3. **`touch-action: none` on a 460px-tall mobile viewport blocks page scrolling.** `image-field.css:10, 31`. In `mobile.webp` the field runs to the bottom edge; a finger landing on it pans the field, so the reader cannot scroll past it without finding the ~22px side margins. With ~570px of controls above it (see finding 5), the field starts below two-thirds of a 390×844 screen — DESIGN.md's "first useful action fits at 390×844" and "leave room around the thing the reader came to try" (lines 11, 19) are not met.

4. **Default view discards information the grid shows.** `visual-search.tsx:366` defaults to `"field"`. Field cards render only rank and title (`image-field.tsx:451–458`); the grid renders score text and `RankShift` (`visual-search.tsx:930–946`). The revealing comparison DESIGN.md prizes (metadata vs caption) is invisible in the default view.

5. **Caption is untrue during a live run.** Placement is frozen while `busy` (`image-field.tsx:146–152`), but labels come from `latestRows` (`:409`). Mid-run, a center card can read "#57" while an edge card reads "#1", under a caption that says "Arranged by text rank from the center" (`:349–352`). `aria-busy` is set, but nothing visible says the arrangement is stale.

6. **Fallback text becomes illegible in overview.** `vs-field-overview` hides only `.vs-field-card-copy` (`image-field.css:24`); the 12px "Image preview unavailable" text (`:19`) stays and scales with zoom to ~5px at 0.45.

7. Minor: ring order is not distance-monotonic at ring boundaries — `(±3,0)` is 492px from center, `(±2,±2)` is 508px (`field-layout.ts:23–24, 46–60`), so #26 sits closer than #25. Contradicts the "stronger ranks move inward" framing by a hair.

## Provenance

- Credit line (`visual-search.tsx:1011–1023`) names the Space, Lochner/Xenova, webml-community and Rathi, and claims an original layout. Verified: square rings vs the reference's golden-angle spiral; export labels it `ranked-square-rings-v1` (`:605`). Good.
- `reference-analysis.md:7` says preserve **three** attributions; the HF `semantic-image-search-web` pipeline credit is absent. Defensible since the pipeline wasn't adopted, but either add it or amend the analysis to say so.
- Hardcoded fallbacks `?? 51` and `?? 101` (`:992, 994`) will assert stale numbers if the result lacks those fields. Omit the sentence instead.
- Pre-existing but relevant to "preserve the starting case" (DESIGN.md line 50): pressing Run Jev on a recorded preset replaces the recorded scores with an empty live run for the session (`:386–390, 550–567`); the baseline cannot be recalled without reload.

## Suggestions (not defects)

- Remove culling and the render cap entirely; 204 nodes need neither. This also fixes finding 1 and lets assistive tech enumerate every work in rank order.
- Either make rank visible without reading numbers (e.g., two or three size bands, equal within a band, which `reference-analysis.md:28` explicitly allows) or make Grid the default and offer Field as the secondary view.
- Drop per-card borders; let images sit on paper with the rank label. Cards-in-a-bordered-box is the pattern DESIGN.md line 29 warns against.
- Mobile: move zoom controls into a viewport corner, merge Collection into the view-switch row, and use `touch-action: pan-y` (or a shorter viewport) so the page stays scrollable.
- Add wheel/trackpad zoom and a rank-order keyboard step (e.g., PageUp/PageDown) — spatial arrow navigation across rings cannot walk 1→2→3.
- Each keystroke in lexical mode re-lays out all 204 cards instantly (`changeQuery` → `setMethod("lexical")`, `:531–537`). Either a 120–180ms position transition or a short debounce would match DESIGN.md line 54.
- On dialog close after arrow-navigating, focus returns to the original opener, not the last viewed work (`closeArtwork`, `:436–443`).
- The Collection save/open feature (`collection.ts`, ~120 lines + UI) is outside the improvements listed in `reference-analysis.md:27–31`. Question whether it belongs in this change.
- Screenshots lack state captions (DESIGN.md line 45); the two captures are in different states (Collection 0 vs 1).

## Not verified

Runtime behaviour of pointer capture, pinch zoom, focus return, contrast, reduced-motion, frame times and actual stylesheet cascade order. Please treat the specificity and arithmetic claims above as source-derived, to be confirmed in a browser.
