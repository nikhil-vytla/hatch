# ANALYSIS: Jev `route_task` failure-handling fixture

Two real invocations of the configured Jev `route_task` MCP tool were made.
Both passed the complete contents of `sum.ts` and `sum.test.ts` verbatim in
`task.context`, with `task.prompt = "Fix the inclusive-sum bug, returning a
proposed patch"` and `task.outputTokens = 128`. Neither call produced a patch.
No source file was modified, no retry was made, and no routing restriction was
loosened.

## Call 1: `task.id = ""` (sentinel empty string)

Returned status: **`unsupported`**

```json
{
  "schemaVersion": "1",
  "taskId": "",
  "status": "unsupported",
  "classification": {
    "source": "heuristic", "category": "other",
    "difficulty": 0.5, "confidence": 0.5, "latencyMs": 0, "costUsd": 0,
    "evidence": "Version 1 lexical baseline. Scores are uncalibrated; difficulty is a fixed prior."
  },
  "selection": {
    "status": "unsupported", "routeId": null, "candidates": [],
    "explanation": "Task id is required.",
    "inputTokenUpperBound": 0, "outputTokens": 128
  },
  "attempts": [],
  "outcome": {
    "actualRouteId": null, "actualModel": null,
    "totalLatencyMs": 0.3346, "totalCostUsd": 0,
    "failure": "Task id is required."
  }
}
```

Interpretation:

- The published JSON schema only constrains `id` to `type: string`, so the
  empty string passes schema validation and reaches the runtime.
- The runtime applies a stricter rule and rejects the request as
  `unsupported` with `"Task id is required."`.
- The rejection happened before any routing work: `inputTokenUpperBound` is
  `0` (the context was never sized), `candidates` is empty, `attempts` is
  empty, and classification fell back to `category: "other"` (a
  fixed-prior heuristic default rather than an actual read of the prompt).
- This is an input-validity failure, not a capacity failure. The correct
  handling per the fixture is to leave the sentinel id untouched and report
  it; inventing an id would mask the boundary being tested.

## Call 2: `task.id = "boundary-no-route"`

Returned status: **`unavailable`**

```json
{
  "schemaVersion": "1",
  "taskId": "boundary-no-route",
  "status": "unavailable",
  "classification": {
    "source": "heuristic", "category": "bug-fix",
    "difficulty": 0.5, "confidence": 0.5, "latencyMs": 0, "costUsd": 0,
    "evidence": "Version 1 lexical baseline. Scores are uncalibrated; difficulty is a fixed prior."
  },
  "selection": {
    "status": "unavailable", "routeId": null, "candidates": [],
    "explanation": "No destination meets every restriction. Eligibility was not widened.",
    "inputTokenUpperBound": 2556, "outputTokens": 128
  },
  "attempts": [],
  "outcome": {
    "actualRouteId": null, "actualModel": null,
    "totalLatencyMs": 0.1898, "totalCostUsd": 0,
    "failure": "No destination meets every restriction. Eligibility was not widened."
  }
}
```

Interpretation:

- With a valid id, the request got further: the lexical classifier read the
  prompt and labeled it `bug-fix`, and the context was sized
  (`inputTokenUpperBound: 2556`).
- Selection then failed because the local route registry is empty:
  `candidates: []`, `routeId: null`. Status is `unavailable`, distinct from
  Call 1's `unsupported`.
- The explanation states explicitly that `"Eligibility was not widened."`
  The router did not relax restrictions or fall back to a different model on
  its own, and I did not do so either. `attempts` is empty, so no model was
  ever contacted and `totalCostUsd` is `0`.

## Why the two statuses differ

| | Call 1 (`id: ""`) | Call 2 (`id: "boundary-no-route"`) |
|---|---|---|
| `status` | `unsupported` | `unavailable` |
| Failure stage | request validation | destination selection |
| `classification.category` | `other` (never really classified) | `bug-fix` |
| `inputTokenUpperBound` | `0` | `2556` |
| Meaning | request itself is malformed for this runtime | request is fine; no route can serve it |

`unsupported` signals that the runtime will never accept this request as
given, regardless of registry contents. `unavailable` signals a well-formed
request that simply has nowhere to go under the current configuration. These
are different failure classes and should be handled differently by a caller:
the first requires fixing the request, the second requires configuring a
route. Neither is retryable as-is.

## Why no source change or reroute occurred

1. `route_task` by design returns proposed artifacts only; it never applies
   edits. Both calls returned no artifact (`attempts: []`, no diff), so there
   was nothing to review or apply.
2. The fixture instructions prohibit retrying, switching models, loosening
   routing restrictions, changing config, or editing `sum.ts` / `sum.test.ts`.
   All of those were honored.
3. The router itself refused to widen eligibility (Call 2), so no implicit
   reroute happened on the server side either.

## State of the fixture

`sum.ts` still contains the off-by-one (`i < n` instead of `i <= n`), so
`sum.test.ts` still fails for `totalThrough(1)` and `totalThrough(4)`. This is
the expected state; the fixture exercises MCP failure paths, not the fix.
