# MCP route_task Failure Analysis

## Overview

Two calls to `mcp__jev__route_task` were made with identical `prompt`, `context`
(both `sum.ts` and `sum.test.ts` verbatim), and `outputTokens: 128`, but with
deliberately different `task.id` values. Both calls failed before any delegate
model was reached. Neither `sum.ts` nor any test was modified; no retry or
reroute was attempted.

---

## Call 1 — Empty-string task id (`""`)

### Request
```json
{ "id": "", "prompt": "Fix the inclusive-sum bug, returning a proposed patch",
  "context": "…both files verbatim…", "outputTokens": 128 }
```

### Raw response (error)
```json
{
  "schemaVersion": "1",
  "taskId": "",
  "status": "unsupported",
  "classification": {
    "source": "heuristic", "category": "other",
    "difficulty": 0.5, "confidence": 0.5,
    "latencyMs": 0, "costUsd": 0,
    "evidence": "Version 1 lexical baseline. Scores are uncalibrated; difficulty is a fixed prior."
  },
  "selection": {
    "status": "unsupported",
    "routeId": null, "candidates": [],
    "explanation": "Task id is required.",
    "inputTokenUpperBound": 0,
    "outputTokens": 128
  },
  "attempts": [],
  "outcome": {
    "actualRouteId": null, "actualModel": null,
    "totalLatencyMs": 0.233,
    "totalCostUsd": 0,
    "failure": "Task id is required."
  }
}
```

### Analysis

| Field | Value | Meaning |
|---|---|---|
| `status` | `"unsupported"` | The runtime detected an invalid input; the request type itself is unsupported in this state |
| `selection.explanation` | `"Task id is required."` | The empty string `""` fails the runtime's id-presence check |
| `inputTokenUpperBound` | `0` | The payload was **never evaluated**; token counting was skipped entirely |
| `classification.category` | `"other"` | The heuristic baseline ran (it is always cheap), but it had no real bearing — no routing decision was ever attempted |
| `attempts` | `[]` | Zero routing attempts; the failure is pre-routing |
| `totalLatencyMs` | `0.233 ms` | Rejected in under a millisecond — pure input validation |

**Conclusion for Call 1:** The runtime performs a guard check that an `id` field is
present and non-empty. An empty string `""` is schema-valid (the JSON schema type
is `string`) but semantically invalid at the runtime level. The failure mode is
`"unsupported"` — meaning the runtime signals that it cannot process this class of
request at all, rather than reporting a routing or capacity failure. No route
lookup occurred, no model was consulted, and no patch was produced.

---

## Call 2 — Non-empty id, empty registry (`"boundary-no-route"`)

### Request
```json
{ "id": "boundary-no-route",
  "prompt": "Fix the inclusive-sum bug, returning a proposed patch",
  "context": "…both files verbatim…", "outputTokens": 128 }
```

### Raw response (error)
```json
{
  "schemaVersion": "1",
  "taskId": "boundary-no-route",
  "status": "unavailable",
  "classification": {
    "source": "heuristic", "category": "bug-fix",
    "difficulty": 0.5, "confidence": 0.5,
    "latencyMs": 0, "costUsd": 0,
    "evidence": "Version 1 lexical baseline. Scores are uncalibrated; difficulty is a fixed prior."
  },
  "selection": {
    "status": "unavailable",
    "routeId": null, "candidates": [],
    "explanation": "No destination meets every restriction. Eligibility was not widened.",
    "inputTokenUpperBound": 2554,
    "outputTokens": 128
  },
  "attempts": [],
  "outcome": {
    "actualRouteId": null, "actualModel": null,
    "totalLatencyMs": 0.194,
    "totalCostUsd": 0,
    "failure": "No destination meets every restriction. Eligibility was not widened."
  }
}
```

### Analysis

| Field | Value | Meaning |
|---|---|---|
| `status` | `"unavailable"` | Input was valid; routing was attempted but no eligible destination exists |
| `selection.explanation` | `"No destination meets every restriction. Eligibility was not widened."` | Registry is empty (or no route passes all filters); the router did not relax constraints |
| `inputTokenUpperBound` | `2554` | The full payload **was evaluated** for token budgeting — unlike Call 1 |
| `classification.category` | `"bug-fix"` | Lexical baseline correctly identified the task type (the prompt contains "bug") |
| `candidates` | `[]` | No routes exist in the local registry for this fixture environment |
| `attempts` | `[]` | Zero execution attempts; failure is in route selection, not execution |
| `totalLatencyMs` | `0.194 ms` | Slightly faster than Call 1 — no overhead from detecting an invalid id |

**Conclusion for Call 2:** The runtime accepted the non-empty `id`, validated the
full request, computed an `inputTokenUpperBound` of 2554 tokens, and classified the
task as `"bug-fix"`. It then performed a route lookup against a local registry that
contains no eligible destinations. The selection status `"unavailable"` (distinct
from `"unsupported"`) signals a capacity/coverage gap — the infrastructure is
working correctly but there is simply nowhere to send the task. Crucially,
`"Eligibility was not widened"` confirms the router did not fall back to a looser
match; it honored all restrictions and returned empty-handed.

---

## Comparison: `"unsupported"` vs `"unavailable"`

| Dimension | Call 1 (`""`) | Call 2 (`"boundary-no-route"`) |
|---|---|---|
| Top-level `status` | `"unsupported"` | `"unavailable"` |
| Failure layer | Input validation | Route selection |
| Token evaluation | Skipped (`inputTokenUpperBound: 0`) | Performed (`inputTokenUpperBound: 2554`) |
| Classification category | `"other"` (task not meaningfully evaluated) | `"bug-fix"` (task fully lexed) |
| Routing attempted | No | Yes (returned no candidates) |
| Explanation | "Task id is required." | "No destination meets every restriction." |
| Eligibility widened | N/A | No |

---

## Why no source change or reroute occurred

Both statuses (`"unsupported"`, `"unavailable"`) indicate terminal failures with
`attempts: []` and `actualRouteId: null`. The MCP tool never produced a diff,
patch, or artifact of any kind, so there was nothing to apply to `sum.ts` or the
tests. The fixture was constructed precisely to exercise two independent failure
boundaries:

1. **Pre-routing rejection** (empty id) — the tool cannot even classify the request
   as eligible for dispatch.
2. **Post-classification, pre-execution rejection** (empty registry) — the tool
   understands the task but has no place to send it.

In neither case did the runtime relax routing restrictions, attempt a fallback
model, or surface a partial result. The existing failing tests in `sum.test.ts`
(caused by the off-by-one `i < n` rather than `i <= n` in `totalThrough`) remain
unchanged, as required by the fixture.
