"""Benchmark adaptation: rows -> WorldSpecs -> runs, against any agent policy."""

import json
from pathlib import Path

from orrery import engine
from orrery.plugins import build_registry

ROWS = [
    json.loads(line)
    for line in (Path(__file__).parent.parent / "examples" / "benchmarks" / "bfcl_style.jsonl")
    .read_text()
    .splitlines()
    if line.strip()
]


def adapt(brief: dict | None = None) -> list:
    registry = build_registry()
    return registry.adapters["bfcl_style"](ROWS, brief or {})


async def test_oracle_validates_every_adapted_world() -> None:
    """The built-in oracle agent must pass each adapted task — this is the
    self-check that the conversion faithfully encodes the benchmark."""
    for spec in adapt():
        result = await engine.run(spec, seed=0)
        assert result.passed, (spec.name, [(v.name, v.details) for v in result.verdicts])


async def test_adapted_worlds_are_pure_data() -> None:
    """Adapted specs need no Python domain pack: tools are entity data."""
    for spec in adapt():
        assert spec.uses == []
        json_round_trip = spec.model_validate_json(spec.model_dump_json())
        assert json_round_trip.spec_hash() == spec.spec_hash()


async def test_model_agent_runs_same_benchmark() -> None:
    """The SUT is a parameter: the same adapted task runs against a
    model-driven agent (playbook here; a live provider in production)."""
    brief = {
        "policy": {
            "type": "model",
            "params": {
                "client": {
                    "type": "playbook",
                    "params": {
                        "script": [
                            {
                                "tool_calls": [
                                    {
                                        "name": "call_tool",
                                        "arguments": {
                                            "tool": "get_weather",
                                            "args": {"city": "San Francisco", "unit": "celsius"},
                                        },
                                    }
                                ]
                            },
                            {"text": "It's 17°C and foggy in San Francisco."},
                        ]
                    },
                },
                "default_recipient": "user-1",
            },
        }
    }
    registry = build_registry()
    spec = registry.adapters["bfcl_style"]([ROWS[0]], brief)[0]
    result = await engine.run(spec, seed=0)
    assert result.passed, [(v.name, v.status, v.details) for v in result.verdicts]


async def test_wrong_tool_call_fails_contract() -> None:
    brief = {
        "policy": {
            "type": "model",
            "params": {
                "client": {
                    "type": "playbook",
                    "params": {
                        "script": [
                            {
                                "tool_calls": [
                                    {
                                        "name": "call_tool",
                                        "arguments": {
                                            "tool": "get_weather",
                                            "args": {"city": "Boston", "unit": "celsius"},
                                        },
                                    }
                                ]
                            },
                            {"text": "Here you go."},
                        ]
                    },
                },
                "default_recipient": "user-1",
            },
        }
    }
    registry = build_registry()
    spec = registry.adapters["bfcl_style"]([ROWS[0]], brief)[0]
    result = await engine.run(spec, seed=0)
    assert not result.verdict("calls_get_weather_0").passed  # wrong args
    assert result.verdict("responded_to_user").passed  # partial credit is visible
