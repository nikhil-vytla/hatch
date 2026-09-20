# Independent Ghost Brush review

Reviewed the source and the stable preview at `http://127.0.0.1:5195/#experiment/ghost-brush` on September 20, 2026, using the separate `tetris-cross-review` browser. No app changes, paid calls or credentials. Findings below describe the reviewed build before the owner's repairs; this review does not verify later patches.

## Browser-reproduced defects

### P2: keyboard undo removes two levels of work during an active stroke

1. Draw one completed sample.
2. Focus the drawing sheet, press Space, ArrowRight and ArrowDown to start a second stroke without lifting.
3. Press Ctrl+Z. On macOS, the advertised Command+Z follows the same handler.
4. Press Ctrl+Shift+Z to redo.

The completed-stroke counter changes from `01 strokes` to `00 strokes`; both the unfinished mark and the previous completed mark disappear. Redo restores only the previous completed stroke. In the actual browser the sheet had 74 path elements during the second stroke, one keyboard-cursor path after undo, and 68 paths after redo. The unfinished mark is absent from history.

`keyDraw` in `src/ghost-brush.tsx` unconditionally rewinds to `session.cursor - 1`. The reducer's `rewind` also sets `active: null`. This bypasses the toolbar's active-stroke guard. Treat the active stroke as one undo unit, retaining it for redo if possible, or refuse history movement until pen-up. One undo during drawing must not also hide the preceding completed stroke.

### P2: restoring a recorded variant loses its source attribution

1. Load the **Blue fabric** recorded example and draw a sample.
2. Preserve a variant named `Recorded source check`.
3. Choose Coastal wind directly.
4. Restore `Recorded source check`.

Before preservation the source label is `Recorded Jev example`. Restoration brings back Indigo loom and its one stroke, but labels the brush `Chosen by hand`. `Variant` and `preserve` omit `brushReceiptId`; `restore` explicitly replaces it with `undefined`. The original receipt still exists, but its association with the restored brush has been lost.

Save and restore the selected brush's receipt association. Direct recipe selection should continue to clear model provenance. Restoring an existing variant should retain its original provenance, with an additional restoration event if needed.

## Deferred source-only observations

- The score-note branch displays `No tags matched; bank order breaks the tie` whenever the highest score is zero, including a valid all-zero Jev ranking. Limit that wording to the lexical source. An all-zero Jev result should say that no recipe received positive fit. This was identified in source; no synthetic provider call was made to reproduce the UI.
- Individual `Stroke` records contain a recipe ID but no receipt/source reference. After later manual choices, the exported global receipt list cannot uniquely establish which source selected the recipe for each earlier stroke. Consider saving the current receipt association at stroke start if stroke-level attribution is required. This is an evidence improvement, separate from the reproduced restored-brush label defect.

Queued-result invalidation and export text escaping were inspected without finding another actionable defect. A direct `exportSvg` probe containing `</title><script>…</script>` produced escaped title text and no raw script element. That check is limited to the exporter and does not constitute a general security audit.
