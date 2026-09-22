# Native gateway and observed accounting

The application gateway now preserves native structured questions and records every outbound HTTP attempt. A rejected answer retains independently reported model identity, token usage and cost. Missing observations stay unknown, including a total whose earlier attempt has no reported charge.

This slice follows the [four-language native adapters](../native-questions-2026-09-22/README.md). It delivers the shared gateway, Score agreement helper and request accounting. The typed decision envelope, CLI/MCP classifier integration and wider application redesign remain separate release work.

## Behavior

- Native Choice descriptions, Noul boundaries and Score levels retain their JSON structure. Invalid or undeclared request fields fail before transport. Returned distributions and legends must match the requested question.
- Score retains its fractional index expectation. Its value and distribution must agree within the declared rounding allowance. The allowance is an authored validation rule, not a guarantee about provider precision. Rejections include the raw observations and computed interval.
- Each HTTP attempt records status, timing, requested and reported model, available usage and charge. Provider-internal attempts remain unknown. A failed or malformed answer can still have a known charge; a successful answer can have an unknown total.
- Retries are bounded and limited to transport or transient HTTP failures. Semantic rejection and observer failure do not request another answer. Redirects are refused. Cancellation prevents a late result from becoming a success.
- Composition explicitly materializes the JSON-render library's absent optional fields before native validation. This conversion is limited to that library boundary.

## Verification

[source-v2.json](source-v2.json) pins nine selected source, test and CI files at `8743d7282176e2bdbcff68ddc497c8803b55b6c0`. [source-code-v2.patch](source-code-v2.patch) contains the authored changes against the native-adapter PR. The [verifier](verify_source.py) extracts the exact Git archive with no working-tree overlays and builds the app before installing sibling test dependencies.

All five checks in [verification-v2.json](verification-v2.json) pass:

| Check | Result |
|---|---|
| Application frozen install and production build | Passed |
| Decoder dependency frozen install | Passed |
| Gateway, Score, accounting, caller-key isolation and existing transport tests | 31 passed, 948 assertions |
| Public record integrity | 45 records passed |

The Score tests compare interval bounds against independent vertex enumeration for two through ten levels and exercise 576 generated distributions. Gateway tests send real HTTP only to an ephemeral loopback redirect fixture; other responses are authored transport fixtures. These checks establish contract behavior, not provider quality, billing accuracy or routing performance.

The first [verification condition](verification.json) built successfully, then reported 29 passing tests and a missing Zod import before the decoder tests could execute. The corrected CI installs the adapter's frozen dependencies after the application build. Product source is unchanged between these conditions. The [original verifier](verify_source.v1.py), source record and patch remain available.

The `Jev native gateway` workflow runs the focused checks on pull requests and main. Independent review and remote checks are recorded separately before this slice is called ready. Canonical deployment and the remaining release gates are still open.
