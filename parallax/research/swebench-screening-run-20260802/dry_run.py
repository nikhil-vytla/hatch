from __future__ import annotations

import json
import os
from pathlib import Path

from parallax.canonical import atomic_write, canonical_digest
from parallax.provider import (
    HUD_GATEWAY_ENDPOINT,
    HudGatewayProvider,
    ProviderRequest,
)


def _scripted_transport(endpoint, body, headers, timeout_seconds):
    payload = json.loads(body)
    if endpoint != HUD_GATEWAY_ENDPOINT:
        raise RuntimeError("unexpected HUD endpoint")
    if headers.get("Authorization") != f"Bearer {os.environ['HUD_API_KEY']}":
        raise RuntimeError("HUD credential was not forwarded")
    if payload.get("max_tokens") != 16:
        raise RuntimeError("HUD token boundary was not preserved")
    return json.dumps(
        {
            "id": "no-spend-scripted-response",
            "model": payload["model"],
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "dry run"},
                }
            ],
            "usage": {
                "prompt_tokens": 4,
                "completion_tokens": 2,
                "total_tokens": 6,
            },
        }
    ).encode()


def main() -> None:
    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is not present")
    model = "hud-boundary-model-not-contacted"
    provider = HudGatewayProvider(model, transport=_scripted_transport)
    request = ProviderRequest(
        model=model,
        messages=({"role": "user", "content": "No-spend boundary check."},),
        max_output_tokens=16,
    )
    response = provider.complete(request)
    if response.usage is None:
        raise RuntimeError("scripted HUD response omitted usage")
    receipt = {
        "credential_present": True,
        "endpoint": HUD_GATEWAY_ENDPOINT,
        "estimated_cost_usd": 0.0,
        "kind": "hud_adapter_no_spend_dry_run",
        "network_calls": 0,
        "paid_calls": 0,
        "request_digest": canonical_digest(request),
        "response_model": response.model,
        "response_usage": response.usage.model_dump(mode="json"),
        "transport": "scripted",
    }
    data = (
        json.dumps(
            receipt,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        + b"\n"
    )
    output = Path(__file__).parent / "evidence" / "hud-adapter-dry-run.jsonl"
    atomic_write(output, data)


if __name__ == "__main__":
    main()
