"""Deploy the canonical Bun app and check it with an explicitly supplied caller key."""

import json
import os
import subprocess

import httpx

from .core import ROOT, load_shell_key


def deploy():
    subprocess.run(["bun", "run", "deploy"], cwd=ROOT / "experience-prototypes", check=True)


def cloudcheck():
    load_shell_key()
    key = os.environ.get("AI_GATEWAY_API_KEY")
    if not key:
        raise RuntimeError("Set AI_GATEWAY_API_KEY for the live check")
    endpoint = "https://jev-experiments.vercel.app/api/evaluate"
    payload = {
        "state": "Hello, it is nice to meet you.",
        "questions": {"greeting": {"type": "noul", "instructions": "Is this a greeting?"}},
    }
    anonymous = httpx.post(endpoint, json=payload, timeout=60)
    assert anonymous.status_code == 401, "Anonymous calls must not reach the gateway"
    headers = {"Authorization": f"Bearer {key}"}
    invalid = httpx.post(
        endpoint, json={"state": "hello", "questions": {}}, headers=headers, timeout=60
    )
    assert invalid.status_code == 400
    response = httpx.post(endpoint, json=payload, headers=headers, timeout=60)
    body = response.json()
    result = {
        "anonymous_status": anonymous.status_code,
        "invalid_status": invalid.status_code,
        "authenticated_status": response.status_code,
        "answers": body.get("answers"),
        "latency_ms": body.get("latency_ms"),
        "cost_usd": body.get("cost_usd"),
    }
    from .core import save

    save(ROOT / "results/deployment-check.jsonl", result)
    print(json.dumps(result, indent=2))
    response.raise_for_status()
