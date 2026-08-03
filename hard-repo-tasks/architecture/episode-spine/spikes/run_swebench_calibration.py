"""Run real gateway agents over matched SWE-bench intent arms."""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from hud.agents import create_agent
from hud.agents.base import Agent
from hud.eval.runtime import DockerRuntime
from hud.eval.task import Task
from mcp import types as mcp_types

ARMS = ("static", "matched", "evolved")
ENVIRONMENT = "parallax-swebench-django-11099"
SYSTEM_PROMPT = """Work in the provided repository using shell tools.
Follow the latest user intent while preserving relevant prior context.
When explicitly asked only to inspect or plan, do not modify files.
When implementation is requested, make the smallest correct change and test it."""


class ScriptedGatewayAgent(Agent):
    """Keep one provider conversation and workspace across director turns."""

    def __init__(self, model: str, *, max_steps_per_turn: int = 12) -> None:
        self.inner = create_agent(
            model,
            max_steps=max_steps_per_turn,
            system_prompt=SYSTEM_PROMPT,
        )
        self.max_steps_per_turn = max_steps_per_turn

    async def __call__(self, run) -> None:
        opening = json.loads(run.prompt_text)
        director = await run.client.open("director")
        ssh = await run.client.open("ssh")
        prompt = [
            mcp_types.PromptMessage(
                role="user",
                content=mcp_types.TextContent(type="text", text=opening["turn"]),
            )
        ]
        state = await self.inner._initialize_state(prompt=prompt)
        state.tools, state.params = await self.inner._build_tools({"ssh": ssh})

        while True:
            await self.inner._loop(
                run,
                state,
                max_steps=self.max_steps_per_turn,
                system_prompt=SYSTEM_PROMPT,
                citations_enabled=False,
            )
            revealed = await director.call_tool("advance", {"token": opening["token"]})
            if revealed.structuredContent["done"]:
                break
            state.messages.append(
                self.inner._format_user_text(revealed.structuredContent["turn"])
            )


async def _run(args: argparse.Namespace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for repetition in range(args.repetitions):
        for arm in args.arms:
            started = datetime.now(UTC)
            task = Task(env=ENVIRONMENT, id="episode", args={"arm": arm})
            try:
                job = await task.run(
                    ScriptedGatewayAgent(
                        args.model,
                        max_steps_per_turn=args.max_steps_per_turn,
                    ),
                    runtime=DockerRuntime(args.image),
                )
                run = job.runs[0]
                row = {
                    "arm": arm,
                    "elapsed_seconds": (
                        datetime.now(UTC) - started
                    ).total_seconds(),
                    "error": None,
                    "evaluation": run.evaluation,
                    "model": args.model,
                    "repetition": repetition,
                    "reward": run.reward,
                    "trace_id": next(
                        (
                            str(value)
                            for name in ("trace_id", "public_id", "id")
                            if (value := getattr(run.trace, name, None))
                        ),
                        "",
                    ),
                }
            except Exception as error:
                row = {
                    "arm": arm,
                    "elapsed_seconds": (
                        datetime.now(UTC) - started
                    ).total_seconds(),
                    "error": f"{type(error).__name__}: {error}",
                    "evaluation": None,
                    "model": args.model,
                    "repetition": repetition,
                    "reward": None,
                    "trace_id": None,
                }
            rows.append(row)
            print(json.dumps(row, sort_keys=True), flush=True)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--arms", default=",".join(ARMS))
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--max-steps-per-turn", type=int, default=12)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.arms = tuple(args.arms.split(","))
    unknown = set(args.arms) - set(ARMS)
    if unknown:
        raise ValueError(f"unknown arms: {sorted(unknown)}")
    rows = asyncio.run(_run(args))
    args.out.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
    )


if __name__ == "__main__":
    main()
