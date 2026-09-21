# Malformed-Output Integration Fixture — Analysis

## Date
2026-09-20

## Objective
Invoke `mcp__jev__route_task` exactly once (id `malformed-fixture`) to obtain a
bug-fix diff for `sum.ts`, then apply it only if a usable artifact was returned.

---

## Source Files Examined

### `sum.ts`
```ts
export function totalThrough(n: number): number {
  let total = 0;
  for (let i = 1; i < n; i++) total += i;   // bug: i < n is exclusive
  return total;
}
```

### `sum.test.ts`
```ts
import { expect, test } from "bun:test";
import { totalThrough } from "./sum";
test("inclusive total", () => {
  expect(totalThrough(0)).toBe(0);
  expect(totalThrough(1)).toBe(1);   // fails — receives 0
  expect(totalThrough(4)).toBe(10);  // would fail too if reached
});
```

### Observed test run output
```
error: expect(received).toBe(expected)
Expected: 1
Received: 0
(fail) inclusive total [0.20ms]
0 pass  /  1 fail
```

The loop condition `i < n` is off-by-one: it never adds `n` itself, so
`totalThrough(1)` accumulates nothing and returns `0` instead of `1`.

---

## MCP `route_task` Call

| Field | Value |
|---|---|
| `id` | `malformed-fixture` |
| `outputTokens` | `128` |
| `route selected` | `malformed-local` |
| `model reported` | `malformed-fixture` |

---

## Returned Status and Error

The tool call raised an **error** response (not a successful result).
Key fields from the JSON error payload:

```json
{
  "schemaVersion": "1",
  "taskId": "malformed-fixture",
  "status": "error",
  "attempts": [
    {
      "status": "malformed",
      "actualModel": "malformed-fixture",
      "error": "Destination returned an invalid artifact.",
      "rawOutput": "MALFORMED_FIXTURE_PAYLOAD",
      "latencyMs": 5.52
    }
  ],
  "outcome": {
    "failure": "Destination returned an invalid artifact."
  }
}
```

- **`status`**: `"error"` at the top-level task level.
- **`attempts[0].status`**: `"malformed"` — the single attempt did not produce a
  parseable/valid diff or code artifact.
- **`attempts[0].rawOutput`**: `"MALFORMED_FIXTURE_PAYLOAD"` — a sentinel string
  that is not a unified diff, not TypeScript source, and not any structured
  patch format that could be applied.
- **`outcome.failure`**: `"Destination returned an invalid artifact."` —
  the router itself confirmed no artifact is available.
- No retry was attempted (the router made exactly one attempt; no additional
  attempt was triggered).

---

## Why the Source Files Were Left Unchanged

The instructions are explicit:

> Do not fix, edit, or apply anything to `sum.ts` or any test file when no
> usable artifact is returned.

The route_task call produced **no usable artifact**:

1. The tool response was classified as an error, not a success.
2. The only `rawOutput` is the opaque string `"MALFORMED_FIXTURE_PAYLOAD"`,
   which carries no diff, no patch hunks, and no replacement source.
3. Applying an unverifiable or empty artifact risks introducing arbitrary or
   incorrect changes; the fixture is designed to surface exactly this scenario.
4. The bug in `sum.ts` (exclusive `i < n` loop bound) is understood, but
   self-authoring a fix outside the routing workflow would bypass the
   integration contract being tested.

Therefore `sum.ts` and `sum.test.ts` remain exactly as committed.  The
pre-existing test failure (`totalThrough(1)` returning `0` instead of `1`) is
expected and left in place per the fixture instructions.

---

## Summary

| Step | Outcome |
|---|---|
| Read `sum.ts` + `sum.test.ts` | ✅ Complete |
| Run existing tests (observe only) | ✅ 1 fail, as expected |
| Call `route_task` (id `malformed-fixture`, once) | ✅ Called exactly once |
| Received usable artifact? | ❌ No — status `malformed`, rawOutput is a sentinel |
| Applied changes to `sum.ts`? | ❌ No — prohibited when no usable artifact |
| Retried routing call? | ❌ No — prohibited by instructions |
