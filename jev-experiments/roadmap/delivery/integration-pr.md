### Summary

This wires the reviewed runtime, router, local study and playable modules into the existing Jev site. The home page opens with a working material canvas, detailed evidence stays available in inspectors, and the footer credits the original builders and states the requested TypeSafe AI disclaimer.

Existing application changes are delivered in `application.patch` under the repository's research-folder rule. `apply.sh` checks for conflicts before applying that patch and installing the provider-free workflow. The Vercel root stays `jev-experiments/experience-prototypes`; this PR does not claim the patched application is deployed.

<pr-train-toc>

- Typed runtime: pending root links
- Routing and client integration: pending root links
- Local study and Mac toolkit: pending root links
- Playable scenes and design research: pending root links
- Application and release evidence: pending root links, current PR

</pr-train-toc>

### Hypothesis

A scene that responds immediately, with nearby controls and inspectable decisions, is a stronger entry to the lab than a catalog of configuration panels. The site should let users play locally and distinguish recorded evidence, hypothetical pricing and actual provider execution.

### Learnings

- The shared decision contract, routing executor and artifact checks have concrete consumers. Materials, Tetris, crowd and music keep their own clocks and validity rules. No universal simulation engine or new graphics framework was introduced.
- Prepared local files can hide broken publication. The clean-checkout verifier starts from Git source and committed inputs, then compares JSONL preparation and every downloadable evidence asset by content hash.
- A viewport screenshot alone missed the cost of controls above the mobile canvas. Shorter introductory copy and a compact home layout now put the complete material canvas within a 390 × 844 viewport, with other scenes available below it.
- Protocol, prototype and release reviews are separate retained artifacts. Their conclusions require independent disposition; model review is not automatic approval.

### Testing

- [x] Eleven provider-free verification commands passed, including 98 shared/runtime/router/scene tests, 171 application/engine tests, Python suites, TypeScript, Bun production build, publication integrity and download integrity. The shared suite made 495 assertions after the final boundary fixes.
- [x] The canonical-root clean checkout builds the app before installing sibling dependencies. Every one of 45 prepared public JSON files is compared with the working build; all 61 evidence assets retain exact source bytes.
- [x] Chromium actually downloaded 56 routing/study artifacts. Materials and Tetris protocol/trace downloads also have retained byte checks. Desktop/mobile emulation, keyboard/touch, dark mode and reduced motion passed; no physical-device test is claimed.
- [x] Eight serialized active-scene samples cover materials, crowd, Tetris and music at desktop and 390 px sizes. Frame-interval p95 was 16.7–16.8 ms on this host, with no interval over 33 ms or browser Long Task in the ten-second samples. These are browser observations, not a guarantee of frame presentation on other hardware.
- [x] Three Fable 5.1 Global review sessions have verified provider/model provenance, retained feedback and independent dispositions. The final review found two router edge cases and wording/provenance corrections; current regression results are retained.
- [x] The existing canonical GitHub-main deployment is healthy. The new application patch has not been deployed; successful Vercel checks on these artifact-only PRs do not deploy the patch.
