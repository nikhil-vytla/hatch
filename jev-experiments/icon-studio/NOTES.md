# Icon studio investigation

- User referenced sandra-arato/icon-matcher-ui and requested a better icon-selection experience. Read its current README: semantic Choice search across libraries, sharding, alternatives and visible inference. Its shared-owner-key architecture is not adopted; this app keeps visitor BYOK.
- Existing Logo studio only composes five hand-coded symbols. A related icon-search view will use licensed Lucide vectors, contextual UI previews, comparison, manual styling and export. It will identify fixed library art separately from Jev's semantic choices.

- Added a semantic icon workbench: full 1,703-icon library, six saved product contexts, full-library group tournament with explicit abstention, local lexical browsing, persistent manual shortlist, nav/card/button previews, stroke/size/color controls and SVG/React export. Input edits invalidate and cancel in-flight requests; a partial tournament cannot masquerade as a completed selection. Lucide vectors are generated from the installed dependency at build time and retain its license.

- Browser cancellation regression passed with an explicit mocked 1.5-second response and synthetic memory-only key: editing the label after request issuance cancelled the tournament, preserved the new label, made no second request and left no stale selection. Disconnected the synthetic key after the check.
