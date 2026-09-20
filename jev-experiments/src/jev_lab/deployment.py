"""Deploy only the gallery, passing secrets to Vercel through stdin."""

import json
import os
import secrets
import subprocess

import httpx

from .core import ROOT, load_shell_key


def deploy(configure=False):
    web = ROOT / "web"
    if configure:
        load_shell_key()
        key = os.environ.get("AI_GATEWAY_API_KEY")
        if not key:
            raise RuntimeError("No authorized gateway key is configured")
        token_path = ROOT / ".cache" / "live-access-token"
        if not token_path.exists():
            token_path.parent.mkdir(exist_ok=True)
            token_path.write_text(secrets.token_urlsafe(32))
        token_path.chmod(0o600)
        values = {"AI_GATEWAY_API_KEY": key, "LAB_ACCESS_TOKEN": token_path.read_text().strip()}
        for name, value in values.items():
            command = [
                "bunx",
                "--bun",
                "vercel",
                "env",
                "add",
                name,
                "production",
                "--sensitive",
                "--yes",
                "--force",
            ]
            process = subprocess.run(
                command,
                cwd=web,
                input=value,
                text=True,
                capture_output=True,
                timeout=90,
                check=False,
            )
            # Never emit credential values, even if a future CLI echoes its input.
            output = process.stdout + process.stderr
            for secret in values.values():
                output = output.replace(secret, "[redacted]")
            print(output, flush=True)
            if process.returncode:
                raise RuntimeError(f"Could not configure {name}")
        print(f"Live access token saved privately at {token_path}", flush=True)
    subprocess.run(["bun", "run", "build"], cwd=web, check=True)
    subprocess.run(["bunx", "--bun", "vercel", "deploy", "--prod", "--yes"], cwd=web, check=True)


def cloudcheck():
    token = (ROOT / ".cache/live-access-token").read_text().strip()
    endpoint = "https://jev-experiments.vercel.app/api/evaluate"
    payload = {
        "state": "Hello, it is nice to meet you.",
        "questions": {"greeting": {"type": "noul", "instructions": "Is this a greeting?"}},
    }
    anonymous = httpx.post(endpoint, json=payload, timeout=60)
    assert anonymous.status_code == 401, "Anonymous calls must not reach the gateway"
    headers = {"Authorization": f"Bearer {token}"}
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

    save(ROOT / "results/deployment-check.json", result)
    print(json.dumps(result, indent=2))
    response.raise_for_status()
