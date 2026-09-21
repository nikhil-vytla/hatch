# Independent release scene review

One evidence-access gap was found and fixed. The materials inspector claimed its instruction labels were frozen, but visitors could not open the protocol or label file. Root added two downloads using Vite asset URLs in [MaterialsSandbox.tsx](../../../materials/MaterialsSandbox.tsx:1097). The protocol and labels themselves were not changed. The [retained source inventory](source-audit-after.json) confirms both imports and links; root's [browser download check](../../../verification/materials-downloads.json) confirms expected filenames and byte-identical hashes.

No new consequential stale-decision or keyboard/touch defect was found in this bounded source review. This is not a fresh browser acceptance run or a guarantee that every interaction is bug-free.

## Source evidence

| Area | Reviewed behavior and references |
| --- | --- |
| Materials | Revision and abort invalidation cover rule edits, painting, reset, branch preservation and scene replacement. Import completion checks revision and mount state. Unmount aborts and advances the revision. [Handlers](../../../materials/MaterialsSandbox.tsx:199), [import/request guards](../../../materials/MaterialsSandbox.tsx:263), [cleanup](../../../materials/MaterialsSandbox.tsx:427). |
| Music | Separate audio/model generations prevent stale startup and recommendations. Editing cancels requests; reset/source changes stop audio; unmount invalidates both generations and disposes the owned engine. [Lifecycle and request guards](../../../../experience-prototypes/src/music-arranger.tsx:91). Phrase locks and continuity remain code constraints; blind auditions are labeled personal preference with playback-start checks, not quality evidence. [Blind audition](../../../../experience-prototypes/src/music-arranger.tsx:176). |
| Crowd | Notice edits cancel the affected requests; reset/branch/pause cancel both lanes and advance epochs. Reply application checks branch, epoch, notice revision and resident intent version. [UI invalidation](../../../../experience-prototypes/src/live-crowd.tsx:176), [branching](../../../../experience-prototypes/src/live-crowd.tsx:224), [engine checks](../../../../live-worlds/crowd/engine.ts:690). The recorded replay and local keyword/fallback policies remain separately labeled. |
| Tetris | Settings/handoff changes invalidate lane requests; timeline/reset operations advance session epochs; callbacks reject cancelled tickets and stale pieces. Unmount cancels provider requests and delayed local replies. [Session](../../../../live-worlds/tetris/session.ts:60), [reply checks](../../../../live-worlds/tetris/session.ts:157), [component cleanup](../../../../experience-prototypes/src/live-tetris.tsx:64). Local delay demonstrations are expressly excluded from Jev measurements. |
| Input and motion | Materials provides keyboard painting/inspection, pointer capture and cancellation, and starts paused for reduced motion. Tetris exposes focused keyboard controls plus touch buttons. Crowd provides resident buttons as an alternative to canvas selection. Music notes and edits are buttons/native controls. Reduced-motion CSS disables decorative transitions; crowd's renderer suppresses bobbing/rain movement. [Materials input](../../../materials/MaterialsSandbox.tsx:697), [Tetris input](../../../../experience-prototypes/src/live-tetris.tsx:81), [crowd resident controls](../../../../experience-prototypes/src/live-crowd.tsx:910), [music notes](../../../../experience-prototypes/src/music-arranger.tsx:34). |
| Catalog and claims | Current inventory contains 41 entries. All data-backed entries have prepared JSON; materials and routing have direct entry components. No missing-data placeholder was identified. The reviewed scenes distinguish procedural behavior, recorded/live model outcomes and user edits. [Catalog](../../../../experience-prototypes/src/catalog.ts:36), [route dispatch](../../../../experience-prototypes/src/main.tsx:669). This inventory does not establish usability of all 41 entries. |
| Credits | Footer credits distinguish original Laya from Dobry's playground, credit Eric Zhang's scoring method and daseinlabs, and link routing, interaction and design references. Materials/Sandspiel, Tone.js and the relevant author references are present. [Builder credits](../../../credits.tsx:1). No new consequential attribution gap was found within the supplied design-reference scope. |

## Scope and reproduction

[source-audit.ts](source-audit.ts) records source hashes, catalog/data presence and credit links. It does not run a simulation, render frames or call a model.

```sh
bun run jev-experiments/roadmap/playable/review/release-scenes/source-audit.ts source-audit-after.json
```

Existing passing browser checks were not repeated because source inspection raised no new behavior concern. Root completed the new protocol/label download check. No product file was changed by this reviewer.

After this inventory, root found and corrected stale Tetris wording that denied new paid-model runs. The current [six-game report](../../../tetris/README.md) distinguishes the new three-seed cohort from the historical games and retains failures, unknown costs and framing limitations. That later finding was outside this review's saved source snapshot; it reinforces the limited scope of the conclusions above.
