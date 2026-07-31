from __future__ import annotations

from hud import Environment
from mcp.types import PromptMessage

from parallax.autoresearch import verify_response

env = Environment(name="parallax-intent-chat")


@env.template()
async def intent_chat(messages: list[PromptMessage], expected: int):
    answer = yield messages
    _parsed, reward = verify_response(str(answer or ""), expected)
    yield reward
