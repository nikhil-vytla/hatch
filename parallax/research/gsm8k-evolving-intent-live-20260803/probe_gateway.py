"""Cheap pre-spend probe of the HUD gateway.

Answers four questions before any experiment design is frozen:

1. Does the chosen model respond at all, and what model name does it report?
2. Does the gateway accept an OpenAI-style ``seed`` parameter, and if it does,
   does the seed actually change or pin sampling?
3. Does ``temperature`` reach the model (is there observable nondeterminism)?
4. Does a construction-stage prompt come back as bare JSON or inside a
   Markdown fence?

Every answer is written to ``evidence/gateway-probe.json``. No answer is
assumed. Total cost is a few tenths of a cent.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ENDPOINT = "https://inference.beta.hud.ai/v1/chat/completions"
MODEL = "claude-haiku-4-5"
ROOT = Path(__file__).parent
OUTPUT = ROOT / "evidence" / "gateway-probe.json"

RANDOM_PROMPT = (
    "Pick any 4-digit number between 1000 and 9999. "
    "Reply with only that number and nothing else."
)
CONSTRUCTION_PROMPT = json.dumps(
    {
        "question": (
            "Natalia sold clips to 48 of her friends in April, and then she "
            "sold half as many clips in May. How many clips did Natalia sell "
            "altogether in April and May?"
        )
    },
    sort_keys=True,
    separators=(",", ":"),
)


def _post(payload: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    api_key = os.environ.get("HUD_API_KEY")
    if not api_key:
        raise RuntimeError("HUD_API_KEY is required")
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {"ok": True, "body": json.loads(response.read())}
    except urllib.error.HTTPError as error:
        return {
            "ok": False,
            "status": error.code,
            "body": error.read().decode(errors="replace")[:2000],
        }
    except Exception as error:
        return {"ok": False, "status": None, "body": f"{type(error).__name__}: {error}"}


def _call(
    prompt: str,
    *,
    temperature: float,
    seed: int | None = None,
    max_tokens: int = 64,
    system: str | None = None,
) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    if system is not None:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload: dict[str, Any] = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if seed is not None:
        payload["seed"] = seed
    result = _post(payload)
    if not result["ok"]:
        return {"error": result}
    body = result["body"]
    choice = body["choices"][0]
    usage = body.get("usage") or {}
    return {
        "text": choice["message"].get("content"),
        "finish_reason": choice.get("finish_reason"),
        "reported_model": body.get("model"),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
    }


def main() -> None:
    probe: dict[str, Any] = {"model": MODEL, "endpoint": ENDPOINT}

    probe["baseline_temp0"] = _call(
        "What is 2+2? Reply with only the digit.",
        temperature=0.0,
    )

    probe["temp1_noseed_a"] = _call(RANDOM_PROMPT, temperature=1.0)
    probe["temp1_noseed_b"] = _call(RANDOM_PROMPT, temperature=1.0)
    probe["temp1_noseed_c"] = _call(RANDOM_PROMPT, temperature=1.0)

    probe["temp1_seed12345_a"] = _call(RANDOM_PROMPT, temperature=1.0, seed=12345)
    probe["temp1_seed12345_b"] = _call(RANDOM_PROMPT, temperature=1.0, seed=12345)
    probe["temp1_seed99999"] = _call(RANDOM_PROMPT, temperature=1.0, seed=99999)

    probe["construction_fencing"] = _call(
        CONSTRUCTION_PROMPT,
        temperature=0.0,
        max_tokens=256,
        system="parallax-stage:extract-intent\nReturn one strict JSON object.",
    )

    probe["submission_contract_absent"] = _call(
        "I need help with calculate total clips sold. Use clips april: 48. "
        "Use clips may ratio: half of april.",
        temperature=0.0,
        max_tokens=64,
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(probe, indent=2, sort_keys=True) + "\n")
    print(json.dumps(probe, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
