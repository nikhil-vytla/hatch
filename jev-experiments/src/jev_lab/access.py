"""Check permitted writing models without changing account settings or credits."""

from .core import ROOT, save


async def access(client, quick=False):
    results = []
    for model in ("google/gemini-2.5-flash-lite", "openai/gpt-oss-20b"):
        try:
            out = await client.request(
                "/v1/chat/completions",
                {
                    "model": model,
                    "messages": [{"role": "user", "content": "Write only: ready"}],
                    "max_tokens": 100,
                    "temperature": 0.2,
                },
                "writer-access",
            )
            content = out["raw"]["choices"][0]["message"].get("content")
            results.append({"model": model, "ok": bool(content), "text": content})
            if content:
                save(
                    ROOT / ".cache" / "writer-model.json",
                    {
                        "model": model,
                        "reason": "Sonnet denied by gateway free-tier access; this alternative completed an authenticated smoke test.",
                    },
                )
                break
        except Exception as exc:
            results.append({"model": model, "error": str(exc)})
    return {"rows": results}
