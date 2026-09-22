# Where Jev does the work

The [interactive atlas](show-me-jev-capabilities.html) explains all 41 entries in the local catalog: what reaches Jev, which questions it answers, how code uses the result, what probabilities change, and what the existing evidence supports. Search by experiment or capability, inspect call sites, compare question representations, and export the underlying [audit data](atlas.json).

The audit finds broad use of Choice, Noul and Score, but a clear limit in our wrappers. Native structured instructions and criterion descriptions cannot pass through the current gateway. The shared runtime also loses descriptive ordinal levels and some supplied criteria, and exposes an argmax in place of a primitive-specific Score summary. [Repeatable provider-free probes](runtime-probe-results.json) establish these implementation behaviors. They do not establish whether richer questions improve model quality.

## The visual and the site

The standalone file uses the paper, ink and editorial type direction from [DESIGN.md](../DESIGN.md). The experiment list leads to an input/question/code/evidence sequence. A second view compares an authored flat question with an equivalent native structured question. A third prioritizes deeper studies inside existing experiments. There are no model calls in the visual.

[CapabilityInspector](capability-inspector.tsx) adds a compact "Jev's role" disclosure to each experiment. The application patch also adds a catalog link and publishes the self-contained atlas at `/capabilities.html`. A build-time source check binds each explanation to the audited files and application wiring. Changed or unavailable source metadata shows a dated-snapshot link rather than presenting old behavior as current.

This is a local implementation snapshot, including unreleased work. The reference Git catalog has 40 entries; the local catalog also includes the material sandbox. A clean base build can compile this integration while its older source correctly fails the audit-match guard. The standalone atlas always identifies itself as the local September 22 snapshot. These changes have not been deployed to the canonical site.

## What to deepen

| Priority | Existing experiments | Concrete comparison |
| --- | --- | --- |
| Preserve native question semantics | Shared gateway, runtime and schema adapters | Lossless rich criteria, explicit local coverage, descriptive Score levels and correct response semantics |
| Compare representations | Smart paste, verifier, judgments | Equal information as prose, JSON text and native structure; independent accuracy and review coverage |
| Use distributions to choose a next step | Icons, visual search, adaptive forms, browser intent | Multiple candidate branches, clarification and calibrated abstention at matched coverage |
| Attribute model contributions | Routing, Tetris, crowd, music | Fixed policies and environments, simple controls, complete task outcomes and total overhead |

Every atlas entry includes a more specific opportunity. More questions or a larger prompt do not prove deeper use. Some experiments already use distributions in consequential ways, including training losses, reward calculations and candidate ranking. Others display probabilities or discard them after selecting an answer. The [foundations decision](decision.md) and [implementation checklist](IMPLEMENTATION.md) distinguish the accepted direction from work still open.

## Sources and investigation

TypeSafe AI's [advanced structure](https://docs.typesafe.ai/primitives/advanced), [Score](https://docs.typesafe.ai/primitives/score) and [confidence](https://docs.typesafe.ai/confidence) documentation informed the capability comparison. [Research notes](docs-research.md) distinguish provider interface descriptions from measured lab results; [source metadata](documentation-sources.json) records retrieval hashes.

The [runtime audit](runtime-audit.md) traces the boundary restrictions. Separate [playable](playable-audit.json), [tooling](tooling-audit.json) and [training](training-audit.json) audits supply the visual. Existing recorded outcomes remain unchanged. No new Jev inference or training runs were performed for this audit. [NOTES.md](NOTES.md) records findings and design changes.

## Verification and integration

```sh
python3 jev-experiments/capability-atlas-2026-09-22/verify.py
bun test jev-experiments/capability-atlas-2026-09-22
bun jev-experiments/capability-atlas-2026-09-22/runtime-probes.ts
jev-experiments/.venv/bin/python jev-experiments/capability-atlas-2026-09-22/runtime-probes.py
```

[Browser checks](browser-checks.json) cover filtering, keyboard focus, empty results, mobile layout, dark mode, reduced-motion media, download, per-page disclosure and stale-snapshot behavior. Retained [desktop](screenshots/jev-capability-atlas-desktop.png), [mobile atlas](screenshots/jev-capability-atlas-mobile-dark.png) and [mobile disclosure](screenshots/jev-role-mobile-dark.png) captures show the tested states. [Clean-build evidence](clean-build.json) records Bun installation and compilation from an isolated Git checkout.

The build also prepares source-hashed publication copies of the routing transcripts. Downloaded copies identify their path normalization and metadata omissions; original recorded outcomes remain unchanged.

[application.patch](application.patch) changes existing application integration files. It follows the [image-field integration patch](../semantic-image-field-2026-09-21/application.patch). [roadmap-update.patch](roadmap-update.patch) adds the foundations correction after the browser experiment. [patch-manifest.json](patch-manifest.json) records order and hashes; [verification.json](verification.json) records integrity checks. Only this authored folder is committed. Applying its patches and deploying remain separate steps.
