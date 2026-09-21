# ANALYSIS: malformed-output integration fixture

## What was requested

Call the Jev `route_task` MCP tool exactly once (id `malformed-fixture`,
`outputTokens` 128) with a bug-fix prompt and the complete source of `sum.ts`
and `sum.test.ts`, inspect the result, and leave the repository unchanged
unless a usable artifact came back.

## Route call (single attempt, no retry)

- `taskId`: `malformed-fixture`
- `outputTokens`: 128
- Top-level `status`: **`error`**
- `selection.status`: `selected`, `routeId` `malformed-local` (the only candidate; eligible, `rankScore` 0.5, simulated quality/latency, no cost estimate)
- `classification`: heuristic lexical baseline, category `test-writing`, difficulty 0.5, confidence 0.5 (uncalibrated, per the tool's own evidence string)
- `attempts[0]`:
  - `status`: **`malformed`**
  - `trigger`: `initial` (no retries were made)
  - `actualModel`: `malformed-fixture` (provider-reported)
  - `error`: `Destination returned an invalid artifact.`
  - `rawOutput`: `MALFORMED_FIXTURE_PAYLOAD`
  - `usage`: 1 input token, 1 output token, 0 cached; `costUsd` null
  - `latencyMs`: ~7.5
- `outcome.failure`: `Destination returned an invalid artifact.`
- `outcome.totalCostUsd`: null

The raw output `MALFORMED_FIXTURE_PAYLOAD` is an opaque sentinel string. It is
not a unified diff, not code, and not a structured result. There is nothing in
it that could be reviewed, applied, or tested.

## Why the source was left unchanged

1. **No usable artifact.** `route_task` returns proposals that I am supposed
   to review and apply myself. The only thing returned was a sentinel string
   with an explicit `malformed` attempt status and an `error` top-level status.
   Applying anything derived from it would be fabricating a fix and attributing
   it to the routed destination.
2. **Instructions forbade fallback.** The task said not to retry, not to change
   routing restrictions, and not to fix/edit/apply anything to `sum.ts` or the
   test file when no usable artifact is returned. The failure here is exactly
   that case.
3. **The known bug is out of scope for this fixture.** `sum.ts` uses
   `i < n` where the test ("inclusive total") requires `i <= n`. That is
   obvious from reading the code, but the purpose of this fixture is to verify
   behavior when delegation fails, not to hand-fix the bug. Fixing it locally
   would mask the malformed-output path being exercised.

## Baseline test run (unchanged, expected failure)

`bun test sum.test.ts` was run once for the record, not to repair anything:

```
expect(received).toBe(expected)
Expected: 1
Received: 0
  at sum.test.ts:3:90
(fail) inclusive total
 0 pass, 1 fail
```

`totalThrough(0)` passes; `totalThrough(1)` returns 0 because the loop
excludes `n`. This failure is pre-existing and expected.

## Files touched

- `ANALYSIS.md` (this file) - created.
- `sum.ts` - not modified.
- `sum.test.ts` - not modified.
- No config files modified.
