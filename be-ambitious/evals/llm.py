"""Thin wrapper around `opencode run` pinned to the free OpenCode-hosted DeepSeek model."""

import json
import subprocess
import tempfile
import time

MODEL = "opencode/deepseek-v4.1-flash-free"


class PaidCallError(RuntimeError):
    pass


def ask(prompt: str, retries: int = 3, timeout: int = 600) -> dict:
    """Send one prompt; return {"text", "tokens", "cost"}. Raises if any step reports nonzero cost."""
    last_err = None
    for attempt in range(retries):
        with tempfile.TemporaryDirectory() as d:
            try:
                proc = subprocess.run(
                    ["opencode", "run", "--pure", "--dir", d, "--format", "json", "-m", MODEL, prompt],
                    capture_output=True, text=True, timeout=timeout, cwd=d,
                )
            except subprocess.TimeoutExpired:
                last_err = TimeoutError(f"opencode run timed out after {timeout}s")
                continue
        texts, cost, tokens, tool_calls = [], 0.0, {}, 0
        for line in proc.stdout.splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            part = ev.get("part", {})
            if ev.get("type") == "text":
                texts.append(part.get("text", ""))
            elif ev.get("type") == "step_finish":
                cost += part.get("cost", 0) or 0
                tokens = part.get("tokens", tokens)
            elif ev.get("type") == "tool_use":
                tool_calls += 1
        if cost:
            raise PaidCallError(f"nonzero cost {cost} reported; aborting")
        text = "\n".join(texts).strip()
        if text:
            return {"text": text, "tokens": tokens, "cost": cost, "tool_calls": tool_calls}
        last_err = RuntimeError(f"empty response; stderr tail: {proc.stderr[-500:]}")
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed after {retries} attempts: {last_err}")
