# One Jev application

The current application is deployed to [jev-experiments.vercel.app](https://jev-experiments.vercel.app), using the existing Vercel project and production credentials. The source lives in `jev-experiments/experience-prototypes`; the older `web` folder is the preceding implementation.

`bun run deploy` pins that project, prepares the evidence and browser companion locally, builds the app, and deploys production. The companion, smoke-check script, and current documentation all use the same canonical address. Deployment history remains available for rollback.

Both temporary `jev-experiences` aliases have been removed. The canonical app returns HTTP 200; the former prototype address returns 404. Public assets, the companion download, and authenticated Jev evaluation and composition checks passed. Exact results are in `public-check.json`, `live-check.json`, and `NOTES.md`.
