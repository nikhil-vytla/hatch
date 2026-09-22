# Make the codebase easy to change

- Owner: root integrator, with runtime and scene owners
- Stage: first public release
- Status: workstream accepted; inventory and migration design open
- Depends on: deployment boundary, typed-decision contract, UI/UX release direction
- Evidence: [architecture review](../../roadmap/ARCHITECTURE.md), [existing composer analysis](../existing-composer-analysis.md), [DESIGN.md](../../DESIGN.md)

## Question

Where should maintained application code, reusable tools, research inputs and generated outputs live, and which conventions should every change follow?

## Standing decision

Code organization and style are explicit release work. The user does not require backward compatibility. Preserve meaningful behavior and reproducible evidence while replacing weak structure. Keep Bun, the current Vercel application root, and the existing URL.

The first pass should inventory imports, commands, dependencies, artifact producers and publication consumers. Define a small directory map with clear ownership. Production code currently crosses research folders; a research folder's age must not determine the public application's architecture. Move maintained code to deliberate homes and update every importer. Historical results retain their protocol and provenance.

Agree on TypeScript/React and Python conventions before bulk formatting. Python already has Ruff configuration. The app has build and test scripts but no explicit formatter or linter commands. Prefer a small toolchain with a documented formatter, useful lint rules, strict types and checks that run in CI. Keep formatting-only changes separate from behavioral refactors so reviewers can see what changed. Document naming, imports, error states, asynchronous cancellation, component boundaries and test placement with examples from this repository.

Split modules by responsibilities that can be named and tested, not an arbitrary line-count rule. Delete unused code, dependencies and obsolete compatibility paths after checking consumers. Share a utility when concrete callers benefit. Keep simulation clocks, action validity, histories, metrics and art direction local to their scenes; the decision contract already warrants a shared module.

## Open decisions

- Choose the destination structure from the import and artifact inventory. Do not rename the Vercel root as incidental cleanup.
- Select formatter/linter rules and the exact commands contributors and CI use. Do not add competing tools for the same job.
- Choose migration slices around independent consumers. Pair each move with import, asset and publication verification.
- Decide what becomes maintained source and what remains an immutable research artifact. Preserve links when reorganizing evidence.

## Completion gate

A contributor can find the app, runtime, tools, training, fixtures and publication scripts from one short directory guide, then run the documented checks. A clean checkout installs with Bun and builds at the canonical Vercel root without sibling installs hiding dependencies. Relevant runtime/Python tests, formatting, lint, type checks and JSONL-to-public-JSON integrity pass. Required inputs and deployment settings survive the moves. Review duplication and unused dependencies again after the second integration and before release, recording both extractions and deliberate customization.

Delivery tasks live in the [implementation checklist](../IMPLEMENTATION.md#code-organization-and-style-first-release). This decision does not claim the refactor is complete.
