# Image-search improvement notes

- The user requested an improvement to the existing image-search experiment, informed by webml-community's Semantic Image Field and its source.
- The supplied source URL appears malformed. Start from the Space and verify its linked repository before attributing or adapting implementation.
- The current experiment ranks a fixed collection of 204 public-domain artworks using metadata, museum captions and a keyword baseline. Its saved Jev scores are text-based, not image embeddings or direct vision.
- Preserve the existing collection, provenance and recorded comparison when adding a new interaction or retrieval condition. Keep new evidence separately identified.
- The text browser could not load the Space or tree page. Use the Hugging Face API or an interactive browser to inspect primary source.

- Pinned the reference Space at `5d25812bb2d3e5174c5b05beeb227cdf5205c362`. Its CLIP search uses a rank spiral, not an embedding projection. No license declaration was found for the Space additions; our layout and UI are original.
- Exercised the reference search with “blue mountains at dusk”; the browser showed 60 match controls and its on-device status. This browser action is separate from the source-only analysis.
- Implemented a ranked field with bounded thumbnails, keyboard navigation, pan/pinch/zoom, a complete grid and a twelve-work collection export/import. Existing Jev scores and museum source records remain unchanged.
- Independent review caught unrun scores labeled recorded, stale pending focus after an edge arrow, and busy filtering retaining excluded works. Corrected all three and checked them with provider-free tests or browser interaction.
- Browser checks cover keyboard details/focus return, full 204-work export, import recovery, saved-query context, 390px layout, dark mode and reduced motion. One mocked live request was intercepted; editing cancelled it and changing to Drawings immediately showed only the ten matching works.
- External image delivery remains imperfect: the desktop capture loaded 40 of 72 rendered thumbnails and showed 28 failed previews, with four still loading. Failed works retain their title, rank and source links. Presentation changes do not remove them from the archive.

- Fable called the first field too card-heavy. Final default is the richer grid; field is optional, unframed and uncapped within the viewport. Native touch scrolling is restored, with Move field for touch pan/pinch. Page Up/Down follows rank.
- Final browser checks observed190 overview nodes, amber zoom-compensated focus and139px native touch scrolling. A cancelled intercepted live run restored all204 recorded scores. A separate clean checkout passed frozen Bun installation and production build with only this application patch.

- Re-profiled after removing the cap:190 overview nodes,89 sampled frames during60 pointer steps, p50 8.3ms/p95 10.2ms/max10.4ms on this desktop Chromium run. No new rendering infrastructure was needed.
