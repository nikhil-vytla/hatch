# Browse an artwork archive without losing its evidence

Status: accepted; implemented and checked locally, application patch awaiting integration.
Owner: root / design engineering. Stage: first-release UI/UX improvement.
Dependencies: [design direction](../DESIGN.md), the existing [visual-search protocol](../visual-search/README.md), canonical application root and source attribution.

## Question

What should Jev take from Semantic Image Field, while keeping the current artwork comparison honest and useful?

## Resolution

Keep the larger-image grid as the default. Offer an original ranked field for spatial exploration, with keyboard navigation, explicit touch panning, zoom and reset. Higher ranks occupy earlier square rings; distance between two works is not a semantic distance. The reference's CLIP model and photograph collection are separate from our text-based museum rankings. The [source study](reference-analysis.md) records Joshua Lochner / Xenova, webml-community, Shridhar Rathi and the Transformers.js example credits.

A reader can inspect an artwork, compare rankings, follow its source and keep a collection of up to twelve works. Export the complete ranking and its actual evidence type. Preserve recorded scores when trying a live run. Typing stays local; paid Jev execution requires an explicit action and the reader's key.

The [review dispositions](review-dispositions.md) explain why the first field prototype changed. Retain the simple DOM implementation and viewport filtering; the fixed archive has only 204 works. Do not impose a cap that silently hides visible results. No new rendering library or universal scene engine is needed.

## Boundaries and evidence

The [verification record](verification.json) covers interaction and artifact integrity. It does not establish improved retrieval accuracy. External preview failures remain visible; missing images do not remove works or alter rankings. Browser phone emulation is not physical-device or screen-reader certification.

A future pixel-retrieval condition needs pinned matching image/text encoders, aligned vector checksums, declared truncation and independent relevance labels over this same archive. That research remains open and does not block this interaction improvement.
