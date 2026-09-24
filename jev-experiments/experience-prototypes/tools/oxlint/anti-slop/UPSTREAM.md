# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b (copied with that commit's `skills/install-anti-slop/scripts/install.mjs`, 2026-09-23)
- Installed at: `jev-experiments/experience-prototypes/tools/oxlint/anti-slop/`
- Config: `jev-experiments/.oxlintrc.json` (Oxlint rejects `..` paths, so the config sits above both linted trees)
- Dependencies: `oxlint@1.85.0` and `@oxlint/plugins@1.85.0`, pinned exactly (upstream pins 1.78.0; the install skill says to use the current matching pair)
- Rules: every generic rule plus `oxc/no-accumulating-spread`, at `error`. Effect rules not enabled (no direct `effect` dependency).
- Local additions: TypeScript and React correctness rules (`no-explicit-any`, `consistent-type-imports`, `no-unused-vars`, `eqeqeq`, hooks rules).
- Scope: `bun run lint:arena` covers the arena (`src/arena`, `packages/arena/src`). Older code is not yet linted; widen the paths as it is cleaned.
- Deviations from upstream: none in the rule sources.
