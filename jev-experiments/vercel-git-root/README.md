# Vercel Git root configuration

The `jev-experiments` Vercel project is connected to `nikhil-vytla/hatch`, with production deployments from `main`. Its root is now `jev-experiments/experience-prototypes`, which contains the current Vite app, API functions, package, and Vercel configuration. Installation uses `bun install --frozen-lockfile`, the build uses `bun run build`, and static output is `dist`. Existing access to source files outside the root remains enabled so the build can read the parent recorded results and research assets.

The first Git build exposed an old upload-only assumption: `.vercelignore` excluded every `results` directory. The exclusion is now limited to private access/smoke fixtures, allowing committed JSONL evidence to be reconstructed into the public JSON files during a clean Git build. `before.json`, `after.json`, and `deployment.json` record the settings and verification; no credentials are included.

The GitHub push of `90e8e94` automatically triggered production deployment `dpl_o2fEfjgweCTyRsbFJdKzAKx1fCj4`. Vercel cloned `main`, ran the locked Bun install, prepared the evidence, compiled TypeScript, built Vite, and reached `READY` with the canonical domain assigned. The live homepage, 200 complete JudgeBench cases, and companion ZIP returned 200; the API returned 401 without a visitor key, confirming that both static output and functions were deployed. `public-check.json` records those checks, and `initial-deployment.json` retains the initial failure that exposed the ignore rule.

The root setting is stored in Vercel; `.vercelignore` is the only application file changed. The correction is on `main`, so subsequent GitHub pushes use the working build path. The GitHub integration is now the deployment path for this project.

[Vercel build settings](https://vercel.com/docs/builds/configure-a-build) · [Live app](https://jev-experiments.vercel.app)
