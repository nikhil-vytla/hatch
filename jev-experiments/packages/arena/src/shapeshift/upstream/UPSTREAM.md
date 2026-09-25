# Vendored from anishfn/shapeshift

- Source: https://github.com/anishfn/shapeshift (MIT, see LICENSE here)
- Commit: 5e24166dcbde6e794f0bd5b1b4bd395aaee5fc19 (2026-09-24)
- Files: `src/lib/{color,decide,signals}.ts`, `src/lib/jev/{types,mock,questions}.ts`,
  `src/lib/parse/*.ts`, and the tests `src/lib/__tests__/{decide,parse,signals}.test.ts` with
  `helpers.ts`.

Changes, and nothing else:

1. `@/lib/...` imports are rewritten to relative paths.
2. `jev/questions.ts` imports `choice`, `noul` and `score` from `../../wire` (our gateway's wire
   shape) instead of `@typesafe-ai/sdk`. The question text is unchanged.

These files are excluded from our lint and format (`.oxlintrc.json`, `.oxfmtrc.json`) so they
stay byte-identical to upstream apart from the two changes above. Their tests run with ours.
