# Native adapter source review

The original source and reports agree, but the review found a real decoder defect. Go and Rust rejected every supplied Choice or Noul legend, including descriptions that exactly matched the requested criteria. The focused correction is now in the three owned source files and [legend-fix.patch](legend-fix.patch). It needs a new source commit and fresh exact-archive checks before merge.

I reviewed source `c89327f7f94a7c70551485ffa0a132ee8640c715`, publication base `854657a49a89eb1d19808c9a0e0329be54f037bd`, and report head `291e8817403f9442cfdb2d3040de0eb07af70a8a`. [verify_review.py](verify_review.py) reads Git objects and retained records only. All 40 [evidence checks](evidence.json) passed: the three archive identities, 12 source-file pins, complete 13-path source diff, report-only successor commit, verifier identity, Go/Rust source hashes, eight-check order and original recorded results match. These checks neither rerun those tests nor verify the new correction. They establish no remote CI or deployment result.

The TypeScript adapter's sole new shared import resolves to the committed `native.ts`, which imports no application or later runtime-envelope implementation. The retained app build preceded the sibling adapter install. The recorded TypeScript, Python, Go and Rust outcomes all refer to the same original source commit; Python's one optional-dependency skip remains explicit.

## Findings and correction

| Finding | Evidence and consequence | Disposition |
|---|---|---|
| P2: Go/Rust reject valid Choice and Noul legends | Their original legend branches require `type == score`. Python's existing native tests explicitly preserve legends for all three question types, and TypeScript validates the supplied keys/descriptions for each type. A valid structured response can therefore succeed in Python/TypeScript and fail when decoded by Go/Rust. | Corrected in [Go](../../adapters/go/adapter.go) and [Rust](../../adapters/rust/src/lib.rs), pending fresh execution. |
| P3: transport claim is broader than the checked behavior | The parent README says non-JSON inputs fail before transport. TypeScript `decide` and Go `Decide` forward arbitrary state to their transport without the new question validator. | Root should narrow the sentence to question descriptions and annotations. State validation is outside this correction. |

The new legend checks require exactly the expected option or boundary keys and valid native entries. When criteria are supplied, descriptions must match them. Score keeps its indexed levels and continuous value. Noul without explicit criteria accepts the `true` and `false` descriptions returned by the transport, without inventing a requested description to compare against. The decoder preserves the accepted answers and metadata.

Three new Go test methods and three new Rust test methods cover matching nested descriptions, changed descriptions, missing/extra/wrong keys, invalid scalar entries, explicit Noul criteria, plain Noul boundaries, default Choice labels, and the existing Score behavior. The complete original passing suites remain attached to their original source. They did not cover this discrepancy.

A bounded offline Rust attempt used the original implementation plus the new regression tests. Cargo stopped before compilation because no default toolchain was configured; this is an unavailable execution condition, not a demonstrated regression failure. Go was also unavailable. [fix-manifest.json](fix-manifest.json) records these limits, the three exact changed-file hashes, and the incremental patch hash. Root will run the new tests with its isolated toolchains, retain a failing-before condition if practical, create the revised source commit, and rerun exact-archive verification. No provider, browser, client or performance run occurred in this review.
