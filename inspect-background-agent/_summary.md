Hatch Inspect now has a real three-plane path: Cloudflare-shaped control (SQLite SessionAgent locally, Durable Objects in `cloud/cloudflare`) talking a shared compute HTTP contract implemented by a Node shim and by Modal (`cloud/modal`). The original all-in-one `npm run serve` stays green; `npm run e2e:cloud` proves control→compute→OpenCode→artifacts→destroy. See [design/CLOUD.md](design/CLOUD.md) and [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) for the Inspect topology we mirrored without forking.

- Local monolith: `npm run serve` / `npm run e2e`
- Three-plane: `npm run compute:shim` + `npm run serve:cloud` / `npm run e2e:cloud`
- Deploy targets: Modal ASGI app + Wrangler Worker with SessionAgent/EventBus DOs
