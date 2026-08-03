# Cloudflare control plane

Workers + Durable Objects control plane for Hatch Inspect.

| Binding | Role |
| --- | --- |
| `SESSION_AGENT` | Per-session DO (SQLite transcript, prompt drain) |
| `EVENT_BUS` | Per-session DO (hibernating WebSocket fan-out) |
| `COMPUTE_URL` | Modal ASGI URL or local `npm run compute:shim` |

## Dev (with local compute shim)

```bash
# terminal A
cd inspect-background-agent && npm run compute:shim

# terminal B
cd cloud/cloudflare && npm install && npm run dev
```

`wrangler.toml` defaults `COMPUTE_URL` to `http://127.0.0.1:8790`. From the Workers runtime, reach the host via `http://127.0.0.1:8790` in local wrangler; for remote preview point `COMPUTE_URL` at a deployed Modal endpoint.

## Deploy

```bash
cd cloud/cloudflare
npx wrangler secret put COMPUTE_TOKEN   # optional
npx wrangler deploy
```

Set `COMPUTE_URL` to your Modal `fastapi_app` URL in the dashboard or wrangler.toml.

## Note on UI

The full Hatch web UI (artifacts, session list) runs on the Node three-plane server:

```bash
COMPUTE_URL=http://127.0.0.1:8790 npm run serve:cloud   # :8788
```

The Worker exposes the same `/api/*` session contract for bots and deploy. Point a web client at whichever control plane you prefer.
