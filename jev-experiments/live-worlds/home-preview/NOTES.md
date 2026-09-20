# Home preview notes

- Read the existing hero and card dimensions before implementing the preview. The hero is 400 px tall on desktop, 350 px on narrower screens and 270 px on mobile, with a 445 px wide-screen rule; cards use a 208 px preview area with smaller responsive heights.
- Reusing the project's original deterministic courtyard engine and Canvas renderer. The preview will never import an API helper or request a model judgment.
- Animation will stop completely when offscreen, hidden or reduced motion is requested. Resuming starts from the preserved local world without simulating time spent paused.
- New card thumbnails will be original static SVG compositions with decorative accessibility semantics and no external assets.
- Integration browser checks passed: visible clock advances, offscreen clock stops, reduced motion is static, all seven card thumbnails render as decorative SVGs, unknown IDs return null, and the hero has no nested controls. The 390 px page has no horizontal overflow, and no model request occurred.
- This headed test runner did not reliably mark the original tab hidden after another tab was brought forward. The visibility event handler was therefore tested with an explicit `document.hidden` fixture; this limitation is recorded in the result. Offscreen and reduced-motion checks used actual browser states.
- Visually inspected desktop light, desktop dark, mobile and card screenshots. The existing page has entrance/theme transitions, so final screenshots wait for them to settle.
- Scoped app TypeScript and diff checks passed. No changes to main, catalog or package files, no dependencies, no model calls and no worker commit. Root owns the integrated build.
