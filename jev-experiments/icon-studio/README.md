# A symbol for an idea

Jev chooses an icon by product intent, and a visual workbench lets a person judge that choice in a navigation row, feature card and button. This extends the picker direction in [Sandra Arato's icon-matcher-ui](https://github.com/sandra-arato/icon-matcher-ui) with context previews, a persistent manual shortlist, local library browsing and SVG/React export. Every shape comes from [Lucide](https://lucide.dev/); Jev selects icon names rather than generating or inspecting vector artwork.

## Recorded examples

All 1,703 canonical icons in installed lucide-react 0.577.0 enter each search. A seeded shuffle creates 27 groups of at most 64 candidates, each with an explicit None option. The winners enter a final Choice. Six authored examples produced 30 successful native requests across 43 attempts.

| Label and context | Jev selection | Group winners |
|---|---|---:|
| Quiet hours, pause message notifications | bell-off | 19 |
| Sources, supporting research references | notebook-text | 17 |
| Audience, email recipients | users | 14 |
| Try another direction, duplicate a creative draft | git-branch | 19 |
| Bring it back, product returns | arrow-right-left | 14 |
| A little brighter, photo exposure | aperture | 12 |

These choices vary in usefulness. The two directions in arrow-right-left do not unambiguously communicate a product return. Aperture relates to photography but may be less recognizable as an exposure control than a sun symbol. No independent preference labels were collected, so completion is not accuracy. The final probability is relative to surviving candidates; the workbench does not present it as calibrated suitability or as an exhaustive global rank.

## Use and inspect

The app route is `#experiment/icon-studio`. Saved contexts work without a key. A custom model search uses the visitor's own Gateway key, stored by the app in memory. Changing the label or context cancels and invalidates the previous request. Partial searches do not appear as completed selections. Manual pins survive context changes during the page session.

`collection.ts` derives vector nodes from the installed library at build time and copies its license. Generated copies are ignored by Git. `protocol.ts` contains the exact group and final-choice questions. `record.ts --run` resumes accepted requests after verifying their input hashes. `events.jsonl` retains actual requests, answers and transport attempts; `results.jsonl` uses the shared compact record format and is rendered as JSON by app preparation.

Run from the repository root:

```sh
bun jev-experiments/icon-studio/verify.ts
bun test jev-experiments/icon-studio/protocol.test.ts
```

The verifier reconstructs every request and published winner. Browser checks covered saved selections, pins surviving a context switch, manual selection, stroke controls, missing-key feedback and dark mode at 390 px without horizontal overflow. A full app build and its 104 tests also passed. A separate browser check delayed a synthetic response by 1.5 seconds: editing the label cancelled the tournament, preserved the new input and prevented a stale selection.

Next experiments should reshuffle identical candidate sets, test different label aliases, and collect blinded human preferences. A direct semantic retrieval baseline would reveal whether the two-stage Choice tournament improves on an embedding shortlist. All comparisons should preserve the same final product context and avoid using the six development examples as held-out accuracy claims.
