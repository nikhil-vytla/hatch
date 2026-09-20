# Vercel Git root configuration

The `jev-experiments` Vercel project is connected to `nikhil-vytla/hatch`, with production deployments from `main`. Its root is now `jev-experiments/experience-prototypes`, which contains the current Vite app, API functions, package, and Vercel configuration. Installation uses `bun install --frozen-lockfile`, the build uses `bun run build`, and static output is `dist`. Existing access to source files outside the root remains enabled so the build can read the parent recorded results and research assets.

The first Git build exposed an old upload-only assumption: `.vercelignore` excluded every `results` directory. The exclusion is now limited to private access/smoke fixtures, allowing committed JSONL evidence to be reconstructed into the public JSON files during a clean Git build. `before.json`, `after.json`, and `deployment.json` record the settings and verification; no credentials are included.

Verification of the corrected main-branch build is recorded below when complete. The root setting is a Vercel project setting, so it takes effect without a repository code change; the ignore correction is required for Git-based builds.

[Vercel build settings](https://vercel.com/docs/builds/configure-a-build) · [Live app](https://jev-experiments.vercel.app)
