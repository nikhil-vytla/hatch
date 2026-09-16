"""Pinned decoding is outside the pure verifier and never executes a proposal."""
import json
from ..codec import decode
from ..contracts.commands import ExecuteEffect
from ..errors import VerificationError
from .provider import json_object


def native_text(backend: str, raw: bytes) -> str:
    lines = raw.splitlines()
    texts: list[str] = []
    for line in lines:
        value = json_object(line)
        if backend == "opencode" and value.get("type") == "text":
            part = value.get("part")
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                texts.append(part["text"])
        elif backend == "codex" and value.get("type") == "item.completed":
            item = value.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                texts.append(item["text"])
        elif backend == "claude-code" and value.get("type") == "result" and value.get("is_error", False) is False:
            text = value.get("result")
            if isinstance(text, str):
                texts.append(text)
    if len(texts) != 1:
        raise VerificationError("malformed harness output: exactly one final text required")
    return texts[0]


def proposal(text: str) -> bytes:
    data = text.encode("utf-8")
    value = decode(data)
    if not isinstance(value, ExecuteEffect):
        raise VerificationError("output schema requires an ExecuteEffect proposal")
    return data


def wrap(backend: str, text: str) -> bytes:
    if backend == "opencode":
        value: object = {"type": "text", "part": {"text": text}}
    elif backend == "codex":
        value = {"type": "item.completed", "item": {"type": "agent_message", "text": text}}
    else:
        value = {"type": "result", "result": text, "is_error": False}
    return json.dumps(value).encode()
