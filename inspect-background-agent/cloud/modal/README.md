# Hatch Inspect — Modal compute plane

Implements the shared compute HTTP contract used by the Cloudflare / cloud control plane.

## Contract

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ ok, backend: "modal" }` |
| POST | `/v1/sandboxes` | create Modal Sandbox + git seed/clone |
| DELETE | `/v1/sandboxes/{id}` | terminate |
| GET | `/v1/sandboxes/{id}/artifacts` | diff + files |
| POST | `/v1/sandboxes/{id}/commit` | git commit |
| POST | `/v1/sandboxes/{id}/prompt` | NDJSON agent stream |

Also creates Modal `Dict` `hatch-inspect-sandboxes` and `Queue` `hatch-inspect-prompts` (Ramp-shaped ingress).

## Deploy

```bash
pip install modal fastapi
modal setup
modal deploy cloud/modal/inspect_modal/app.py
```

Set the resulting URL on the control plane:

```bash
export COMPUTE_URL=https://<your-modal-username>--hatch-inspect-compute-fastapi-app.modal.run
npm run serve:cloud
```

## Local stand-in (no Modal account)

```bash
npm run compute:shim   # http://127.0.0.1:8790
COMPUTE_URL=http://127.0.0.1:8790 npm run serve:cloud
```

Same contract; backend reports `local-shim`.
