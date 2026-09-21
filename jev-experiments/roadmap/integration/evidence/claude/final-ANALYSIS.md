# MCP Integration Fixture — Analysis

## MCP Call Summary

All **five** MCP calls were made and returned real responses (none were emulated or skipped).

| # | Tool | Task ID | Status |
|---|------|---------|--------|
| 1 | `route_task` | `fix-sum-bug` | ✅ `ok` — patch returned and applied |
| 2 | `route_task` | `write-boundary-tests` | ✅ `ok` — patch returned and applied |
| 3 | `route_task` | `analyze-repo` | ✅ `ok` — structured JSON returned |
| 4 | `route_task` | `shell-required-impossible` | ⛔ `unavailable` — no-route (see below) |
| 5 | `decide` | `image-unsupported-test` | ⛔ `unsupported` — unsupported kind (see below) |

All three bounded delegations routed to `amazon-bedrock/global.anthropic.claude-fable-5-1` via the `bedrock-delegate` route.

---

## 1. Repository Analysis (from delegation 3)

Returned as `kind: structured` JSON by the delegate.

### Purpose
`sum.ts` exports a single function `totalThrough(n)` intended to return the **inclusive triangular sum** 1 + 2 + … + n (i.e., n(n+1)/2). The test suite ("inclusive total") confirms this intent.

### Bug
**Off-by-one error in loop bound.** The original loop condition was `i < n`, which excludes `n` from the sum, computing the *exclusive* result 1 + … + (n−1) instead.

| Call | Before fix | After fix (expected) |
|------|-----------|----------------------|
| `totalThrough(0)` | 0 ✓ | 0 |
| `totalThrough(1)` | **0** ✗ | **1** |
| `totalThrough(4)` | **6** ✗ | **10** |

**Fix:** `i < n` → `i <= n` (one-character change). An O(1) closed-form alternative is `return (n * (n + 1)) / 2;`.

### Test Quality
The existing test correctly encodes the inclusive contract and is sufficient to catch the bug. Gaps identified by the delegate:
- All assertions in one `test` block, masking which assertion fails first.
- No negative-input coverage.
- No non-integer / non-finite coverage (`Infinity` would hang the iterative loop).
- No large-n case to guard against a future closed-form refactor.

### Suggestions (from delegate)
1. Fix the loop bound or replace with the closed form.
2. Add JSDoc documenting inclusive range and behavior for n ≤ 0.
3. Decide and enforce input validation for negatives and non-integers.
4. Guard against `Infinity` input.
5. Split tests or use `test.each` for clearer diagnostics.
6. Add `package.json` with a `test` script and `tsconfig.json` so the project is self-describing.
7. Consider a property-based test cross-checking the loop against the closed form.

---

## 2. Patches Applied

### Delegation 1 — Bug fix (`sum.ts`)

```diff
--- a/sum.ts
+++ b/sum.ts
@@ -1,6 +1,6 @@
 export function totalThrough(n: number): number {
   let total = 0;
-  for (let i = 1; i < n; i++) total += i;
+  for (let i = 1; i <= n; i++) total += i;
   return total;
 }
```

### Delegation 2 — Boundary tests (`sum.test.ts`)

Four new `test(…)` blocks were appended:
- `"small n values"` — covers n=2 (→3) and n=5 (→15)
- `"large n"` — covers n=100 (→5050)
- `"negative n returns 0"` — covers n=−1 and n=−100
- `"zero returns 0"` — explicit named check for n=0

---

## 3. Test Results

```
bun test v1.3.14

 5 pass
 0 fail
 9 expect() calls
Ran 5 tests across 1 file. [7.00ms]
```

All five tests (1 original + 4 new boundary cases) pass after applying the bug-fix patch.

---

## 4. Failure Handling

### `route_task` with `requiredTools: ["shell"]` — No-Route Result

**Task ID:** `shell-required-impossible`  
**Status:** `unavailable`

The call was made with `requiredTools: ["shell"]`. The router evaluated all configured destinations and found that the only candidate (`bedrock-delegate`) was **ineligible** because:

> "Tool is not permitted: shell." / "Tool is unavailable: shell."

The router's response was:

> "No destination meets every restriction. Eligibility was not widened."

**Explanation:** The `route_task` tool enforces `requiredTools` as a hard eligibility gate. Since no configured route advertises or permits a `shell` capability, the task cannot be delegated and returns `status: "unavailable"` immediately (0 ms, 0 attempts). The restriction was **not loosened** — the system respects the declared constraint rather than silently downgrading to a route that lacks the required tool. This is the correct behavior: it prevents tasks that genuinely require shell execution from being silently dispatched to a model that would only hallucinate a response.

---

### `decide` with `kind: "image"` — Unsupported Result

**Request ID:** `image-unsupported-test`  
**Status:** `unsupported`

The call requested a question of `kind: "image"`, which is not a supported question kind. The tool returned:

```json
{
  "status": "unsupported",
  "decisions": [],
  "issues": [{ "code": "invalid_request", "message": "Supply version 1, requestId, JSON state and typed questions." }]
}
```

**Explanation:** The `decide` tool supports typed question kinds such as `choice`, `boolean`, and `ordinal`. The `image` kind falls outside the supported schema — the tool is a lexical/statistical decision engine, not a vision model, and cannot generate or reason about images. When it encounters an unrecognized or unsupported question kind it returns `status: "unsupported"` with an `invalid_request` issue and an empty `decisions` array rather than attempting to answer or hallucinate a response. No model was invoked (the decision ran locally at ~0.12 ms).

---

## 5. All MCP Calls — Did They Happen?

**Yes. All five MCP calls were actually executed** against the live MCP server:

- Delegations 1–3 each produced real model responses via `amazon-bedrock/global.anthropic.claude-fable-5-1`, with measured token usage and latency (7.9 s, 8.8 s, and 24.3 s respectively).
- Delegation 4 returned a router-level `unavailable` status with a concrete eligibility explanation listing the exact ineligibility reasons per candidate.
- The `decide` call returned a server-generated `unsupported` response with a timing measurement (~0.12 ms local execution).

None of the calls were emulated, skipped, or merely described.
