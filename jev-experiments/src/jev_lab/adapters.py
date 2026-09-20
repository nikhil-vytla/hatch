"""One live response, independently decoded through four typed implementations."""

import asyncio
import json
import subprocess
from typing import Literal

from pydantic import BaseModel, Field

from .core import ROOT
from .semantic import decode, questions_for


class Contract(BaseModel):
    area: Literal["billing", "technical", "account", "other"] = Field(
        description="Which support area applies?"
    )
    refund: bool = Field(description="Is a refund requested?")
    missing_context: float = Field(ge=0, le=1, description="Is essential context missing?")


async def adapters(client, quick=False):
    text = "I was charged twice. Please return the extra payment."
    out = await client.evaluate(text, questions_for(Contract), "adapter-contract")
    rows = [
        {
            "language": "Python / Pydantic",
            "value": decode(Contract, out["answers"]).model_dump(),
            "answers": out["answers"],
            "evidence_preserved": True,
        }
    ]
    commands = [
        ("TypeScript / Zod", ["bun", "run", str(ROOT / "adapters/typescript/decode.ts")]),
        ("Rust / Serde + Schemars", [str(ROOT / "adapters/rust/target/debug/jev-schemars-lab")]),
        ("Go / JSON Schema + validator", [str(ROOT / ".cache/jev-go-adapter")]),
    ]
    for name, command in commands:
        try:
            response = await asyncio.to_thread(
                subprocess.run,
                command,
                input=json.dumps({"answers": out["answers"]}),
                text=True,
                capture_output=True,
                timeout=30,
                check=True,
            )
            parsed = json.loads(response.stdout)
            rows.append(
                {
                    "language": name,
                    "value": parsed["value"],
                    "answers": parsed["answers"],
                    "evidence_preserved": parsed["answers"] == out["answers"],
                    "same_typed_value": parsed["value"] == rows[0]["value"],
                }
            )
        except Exception as exc:
            rows.append({"language": name, "error": str(exc)})
    return {
        "rows": rows,
        "input": text,
        "questions": questions_for(Contract),
        "latency_ms": out["latency_ms"],
        "note": "One real Jev response is decoded independently in four languages. This checks interoperability, "
        "not four independent judgments. Field descriptions are the semantic contract, not just type names. "
        "TypeScript, Rust, and Go also support explicit ordered score rubrics; Python's adapter intentionally stays narrower.",
    }
