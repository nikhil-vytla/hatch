"""Child-process entry point that executes an untrusted strategy file.

Invoked as ``python -I strategy_runner.py <strategy.py>`` with a JSON payload
``{"cases": [{"case_id", "input_text"}, ...]}`` on stdin. Emits
``{"results": [{"case_id", "output", "error", "duration_ms"}, ...]}`` on
stdout. Uses only the standard library so it can run under isolated mode with
no access to the controller's package environment.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any


def main() -> int:
    strategy_path = sys.argv[1]
    payload = json.load(sys.stdin)

    with open(strategy_path, encoding="utf-8") as handle:
        source = handle.read()
    namespace: dict[str, Any] = {"__name__": "strive_strategy"}
    exec(compile(source, strategy_path, "exec"), namespace)  # noqa: S102
    solve = namespace["solve"]

    results: list[dict[str, Any]] = []
    for case in payload["cases"]:
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

    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
