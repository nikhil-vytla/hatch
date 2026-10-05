# Independent routing review

The playable implementation owner reviewed the routing toolkit after finishing the playable changes. No routing files were edited by the reviewer. Four findings were sent to the routing owner and corrected before the provider-free reproduction script ran.

| Finding | Consequence | Post-fix probe |
| --- | --- | --- |
| Fetch followed redirects after validating only the initial local endpoint | A local-only task could leave the configured local endpoint | Redirect receiver received zero requests |
| No cancellation check after the quality verifier returned | A cancelled task could return an accepted artifact | Returned `cancelled` with no final artifact |
| Optional classifier ran before checking its cost reservation | A classifier could spend before the router enforced its cap | Zero-cap request called the classifier zero times |
| MCP destructured parsed `null` before request validation | A malformed line could terminate the server | Returned invalid-request error, accepted the following ping, exited zero |

`routing-post-fix.json` records these outcomes. Reproduce with `bun jev-experiments/roadmap/playable/review/routing-review.ts`. The redirect probe uses only loopback addresses and synthetic public text. The pricing probe records a synthetic charge; it makes no paid call.

The review also sent follow-up notes about cancellation before classification, cached-token price bounds, invalid negative usage/cost, and the distinction between recorded classification metadata and a classifier that changes route selection. Release evidence must not treat an attempted harness tool call as completed delegation: the first Codex fixture records MCP approval rejection and local host repair, with no returned delegate artifact.
