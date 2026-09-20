"""Transport accounting for published results, including early runner versions."""

import json
from collections import Counter
from datetime import datetime

import numpy as np


def compact_game_states(result):
    """Losslessly intern repeated observations in the published replay."""
    observations, lookup = [], {}
    for episode in result.get("episodes", []):
        for frame in episode.get("trace", []):
            if "state" not in frame:
                continue
            state = frame.pop("state")
            key = json.dumps(state, sort_keys=True)
            if key not in lookup:
                lookup[key] = len(observations)
                observations.append(state)
            frame["state_id"] = lookup[key]
    result["observations"] = observations
    result["trace_encoding"] = (
        "Each frame.state_id indexes observations; full original traces remain in the local run."
    )
    result.pop("decision_cache", None)
    return result


def transport_summary(path):
    if not path.exists():
        return None
    attempts = [json.loads(line) for line in path.read_text().splitlines() if line]
    groups, active = [], {}
    for attempt in attempts:
        key = (attempt["tag"], attempt["request_hash"])
        if attempt["attempt"] == 1 or key not in active:
            active[key] = []
            groups.append(active[key])
        active[key].append(attempt)
    elapsed = []
    for group in groups:
        first, last = group[0], group[-1]
        elapsed.append(
            (
                datetime.fromisoformat(last["at"]) - datetime.fromisoformat(first["at"])
            ).total_seconds()
            * 1000
            + last["latency_ms"]
        )

    def percentile(values):
        return (
            {"p50": float(np.percentile(values, 50)), "p95": float(np.percentile(values, 95))}
            if values
            else None
        )

    successful = [a["latency_ms"] for a in attempts if a["status"] == "ok"]
    return {
        "attempts": len(attempts),
        "status_counts": dict(
            Counter(str(a.get("http_status", "transport_error")) for a in attempts)
        ),
        "successful_attempt_latency_ms": percentile(successful),
        "logical_request_latency_ms_including_retries_excluding_queue": percentile(elapsed),
        "reported_usd": sum(a.get("cost_usd") or 0 for a in attempts),
        "attempts_without_cost_metadata": sum(a.get("cost_usd") is None for a in attempts),
        "note": "Logical request duration is reconstructed from recorded attempt timestamps. It includes failed requests and retry waits, but excludes time waiting for the shared concurrency slot.",
    }
