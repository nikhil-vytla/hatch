# Vercel Git root configuration notes

- The user merged PR #54 and connected the existing Vercel project to GitHub. They requested updating the project root directory for the Jev app.
- The current application package and Vercel configuration live in `jev-experiments/experience-prototypes`; parent result files are required during build preparation.
- Checking the project's current Git link, build settings, and support for files outside the app root before changing the root.

- Confirmed GitHub repository `nikhil-vytla/hatch`, production branch `main`, with PR #54 merged at `9e71228`.
- Changed Root Directory from the repository root to `jev-experiments/experience-prototypes` and made the install command explicit as `bun install --frozen-lockfile`. Build remains `bun run build`, output remains `dist`, and the existing outside-root source access remains enabled.
- Created a production deployment directly from the GitHub `main` commit to verify a clean Git checkout, rather than uploading locally prepared assets.

- The first clean Git deployment failed because `.vercelignore` matched both result directories and removed the committed JSONL inputs. Build logs identified `../results/adapters.jsonl` as the first missing file. Replaced the broad `results` exclusion with explicit exclusions for private access/smoke JSON fixtures; environment files and caches remain excluded.

- Pushed the small ignore correction to `main` as `90e8e94`. The GitHub integration automatically created production deployment `dpl_o2fEfjgweCTyRsbFJdKzAKx1fCj4`, proving the new integration and root work together without a local upload.
- Deployment reached READY and received `jev-experiments.vercel.app`. Public checks passed for the homepage, all 200 full JudgeBench cases, the companion ZIP, and missing-key API rejection.

- Added the deployment root, Bun settings, outside-root data dependency, and clean Git build check to the repository's `AGENTS.md` so future code reorganizations also update Vercel's project setting.
