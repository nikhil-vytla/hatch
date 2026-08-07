"""Child-process entry point that executes an untrusted strategy file.

Invoked as ``python -I strategy_runner.py <strategy.py>`` with a JSON payload
``{"protocol": 1, "cases": [{"case_id", "input_text"}, ...]}`` on stdin.
Emits ``{"protocol": 1, "results": [...]}`` on stdout.

Schema discipline is loud (D9): a payload that is not exactly the expected
shape makes the runner exit with code 3 and a diagnostic on stderr — there is
no permissive fallback. Uses only the standard library so it runs under
isolated mode with no access to the controller's package environment.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any

PROTOCOL = 1
EXIT_SCHEMA_MISMATCH = 3


def _fail_schema(message: str) -> "int":
    sys.stderr.write(f"schema-mismatch: {message}\n")
    return EXIT_SCHEMA_MISMATCH


def _validate_payload(payload: Any) -> list[dict[str, str]] | str:
    if not isinstance(payload, dict):
        return "payload is not an object"
    if set(payload.keys()) != {"protocol", "cases"}:
        return f"unexpected payload keys {sorted(payload.keys())}"
    if payload["protocol"] != PROTOCOL:
        return f"unsupported protocol {payload['protocol']!r} (runner speaks {PROTOCOL})"
    cases = payload["cases"]
    if not isinstance(cases, list):
        return "cases is not an array"
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or set(case.keys()) != {"case_id", "input_text"}:
            return f"case {index} has unexpected shape"
        if not isinstance(case["case_id"], str) or not isinstance(case["input_text"], str):
            return f"case {index} has non-string fields"
    return [{"case_id": c["case_id"], "input_text": c["input_text"]} for c in cases]


def main() -> int:
    if len(sys.argv) != 2:
        return _fail_schema(f"expected exactly one argument, got {len(sys.argv) - 1}")
    strategy_path = sys.argv[1]
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        return _fail_schema(f"stdin is not valid JSON: {exc}")

    cases = _validate_payload(payload)
    if isinstance(cases, str):
        return _fail_schema(cases)

    with open(strategy_path, encoding="utf-8") as handle:
        source = handle.read()
    namespace: dict[str, Any] = {"__name__": "strive_strategy"}
    exec(compile(source, strategy_path, "exec"), namespace)  # noqa: S102
    solve = namespace["solve"]

    results: list[dict[str, Any]] = []
    for case in cases:
        started = time.perf_counter()
        output: int | None = None
        error: str | None = None
        try:
            value = solve(case["input_text"])
            if isinstance(value, bool) or not isinstance(value, int):
                error = f"non-integer output of type {type(value).__name__}"
            else:
                output = value
        except Exception:  # noqa: BLE001 - report, don't crash the run
            error = traceback.format_exc(limit=3)
        results.append(
            {
                "case_id": case["case_id"],
                "output": output,
                "error": error,
                "duration_ms": (time.perf_counter() - started) * 1000.0,
            }
        )

    json.dump({"protocol": PROTOCOL, "results": results}, sys.stdout)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
