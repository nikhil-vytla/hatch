Exactly two calls were made to the configured Jev `route_task` MCP tool. Both supplied the complete contents of `sum.ts` and `sum.test.ts` verbatim in `task.context`, used the prompt `Fix the inclusive-sum bug, returning a proposed patch`, and set `outputTokens` to `128`. Only `task.id` differed.

| Call | Task ID | Returned status | Selection explanation and outcome failure |
| --- | --- | --- | --- |
| 1 | `""` | `unsupported` | `Task id is required.` |
| 2 | `boundary-no-route` | `unavailable` | `No destination meets every restriction. Eligibility was not widened.` |

The first call preserved the deliberate empty-string sentinel. Although the published schema accepts a string, runtime validation rejected the empty ID as unsupported. Its selection status was also `unsupported`, and its input token upper bound was `0`.

The second call passed ID validation but found no eligible destination in the fixture's empty local registry. Its selection status was `unavailable`, and its input token upper bound was `2574`. This was a routing availability failure, distinct from the first call's invalid task ID.

Both responses set `isError` to `true`, returned empty candidate and attempt arrays, and reported null route IDs and actual models. Both reported zero cost. Neither returned a proposed patch or attempted a model invocation.

No retry, replacement model, restriction change, configuration change, or additional routing call occurred. The empty ID was not repaired. The second call was the separately requested fixture case. The user explicitly required preserving the source and expected failing tests, so no source or test changes were made and tests were not run. Only this analysis file was written.
