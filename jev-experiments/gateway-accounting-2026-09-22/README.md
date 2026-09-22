# Native gateway and observed accounting

The application gateway now preserves native structured questions and records every outbound HTTP attempt. A rejected answer retains independently reported model identity, token usage and cost. Missing observations stay unknown, including a total whose earlier attempt has no reported charge.

This slice follows the [four-language native adapters](../native-questions-2026-09-22/README.md). It delivers the shared gateway, Score agreement helper and request accounting. The typed decision envelope, CLI/MCP classifier integration and wider application redesign remain separate release work.

## Behavior

- Native Choice descriptions, Noul boundaries and Score levels retain their JSON structure. Invalid or undeclared request fields fail before transport. Returned distributions and legends must match the requested question.
- Score retains its fractional index expectation. Its value and distribution must agree within the declared rounding allowance. The allowance is an authored validation rule, not a guarantee about provider precision. Rejections include the raw observations and computed interval.
- Each HTTP attempt records status, timing, requested and reported model, available usage and charge. Provider-internal attempts remain unknown. A failed or malformed answer can still have a known charge; a successful answer can have an unknown total.
- Retries are bounded and limited to transport or transient HTTP failures. Semantic rejection and observer failure do not request another answer. Redirects are refused. Cancellation prevents a late result from becoming a success.
- Final-observer cancellation still rejects the answer and preserves observed accounting. An observer that stops dispatch does not create an outbound attempt. A known input or output token count cannot exceed a reported total.
- Composition explicitly materializes the JSON-render library's absent optional fields before native validation. This conversion is limited to that library boundary.

## Independent review

The [first independent review](independent-review-v2/README.md) reproduced three gaps despite the initial green suite: final observers could cancel while the gateway still returned success, a pre-dispatch observer exception counted an unsent attempt, and contradictory partial usage passed validation. Its four failing regressions and two controls remain unchanged.

The correction adds cancellation checks around dispatch and completion, excludes undispatched work from outbound accounting, and checks known token components against totals. The [correction review](independent-review-v3/README.md) accepts all three fixes. It confirms that the six maintained regression bodies match the original reproductions, reruns the full suite, and exercises 18 additional boundary cases with 164 assertions. Earlier paid or unknown attempts remain intact through observer failures and cancellation.

## Verification

[source-v3.json](source-v3.json) pins ten selected source, test and CI files at `d93be44fde84ac83992eaa1c7ca2b1f8359aa99d`. [source-code-v3.patch](source-code-v3.patch) contains the authored changes against the native-adapter PR. The [verifier](verify_source.py) extracts the exact Git archive with no working-tree overlays and builds the app before installing sibling test dependencies.

All five checks in [verification-v3.json](verification-v3.json) pass:

| Check | Result |
|---|---|
| Application frozen install and production build | Passed |
| Decoder dependency frozen install | Passed |
| Gateway, Score, accounting, caller-key isolation and existing transport tests | 38 passed, 981 assertions |
| Public record integrity | 45 records passed |

The Score tests compare interval bounds against independent vertex enumeration for two through ten levels and exercise 576 generated distributions. Gateway tests send real HTTP only to an ephemeral loopback redirect fixture; other responses are authored transport fixtures. These checks establish contract behavior, not provider quality, billing accuracy or routing performance.

The first [verification condition](verification.json) built successfully, then reported 29 passing tests and a missing Zod import before the decoder tests could execute. The second condition fixed that test setup and passed 31 tests without changing product source. The third condition adds the independently reviewed product corrections and regressions. Earlier verifiers, records, patches and outcomes remain available.

The `Jev native gateway` workflow runs the seven maintained test targets on pull requests and main. Historical review fixtures keep their original source pins and run separately. The [PR](https://github.com/nikhil-vytla/hatch/pull/72) records corrected-head remote checks before this slice is called ready. Canonical deployment and the remaining release gates are still open.
