# Canonical deployment notes

## 2026-09-20

- The user requested a single app at https://jev-experiments.vercel.app.
- Continuing from the completed experience prototypes. Plan: deploy this source into the existing jev-experiments Vercel project, update canonical links and companion defaults, verify production, and retire the separate public prototype alias.
- Confirmed the original Vercel project already contains `AI_GATEWAY_API_KEY` and `LAB_ACCESS_TOKEN`; no credential replacement was needed.
- Deployment `dpl_9YAFpNFR7BWAgEN8EG7Awb8wLRjY` completed successfully in project `prj_D85FuYXgN0CQm4l1OcsuCQnfK1DO`, with https://jev-experiments.vercel.app as the production alias.
- Local and Vercel TypeScript/Vite builds passed with Bun. Public HTML, assets, recorded journeys, UI compositions, full JudgeBench evidence, documentation, companion ZIP, and sample form passed HTTP checks. The ZIP uses the canonical origin.
- Live API verification passed: anonymous 401, invalid authenticated payload 400, valid Jev judgment 200 at zero reported cost. A real streamed UI revision finished in 764 ms, removed the requested switch, and preserved the edited name. This is one functional check, not a timing benchmark.
- System Python urllib lacked a usable local CA store. Switched the HTTP checks to curl with certificate verification enabled. The papercuts logger reported that this repository has not opted in, so no global log was created.
- Removed both temporary `jev-experiences` aliases. Vercel's alias inventory confirms their removal; the former public prototype address now returns 404 while the canonical app returns 200. The inactive project's historical deployments remain available for rollback.
