# anti-slop (vendored)

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b (copied from `skills/install-anti-slop/assets/anti-slop` by that skill's `scripts/install.mjs`)
- Installed at: `tools/oxlint/anti-slop/` (generic plugin `index.ts`; the Effect plugin in `effect/` is copied but not enabled, since strive does not depend on `effect`)
- Engine: `oxlint` and `@oxlint/plugins` pinned exactly at 1.85.0; bump both together
- Deviations: none in the rule sources. `oxlint.config.ts` also ignores `.audit/`, `target/` and the generated protocol types.
- `vendor/eslint-stylistic/` keeps its own LICENSE and UPSTREAM.md.
