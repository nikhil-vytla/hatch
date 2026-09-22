# Independent native adapter review

Review source commit `c89327f7f94a7c70551485ffa0a132ee8640c715` and final report head `291e8817403f9442cfdb2d3040de0eb07af70a8a`. Inspect imports, standalone boundaries, structured Choice entries, annotations and Score behavior. Read retained source and verification records; do not execute new providers, clients or tests unless a concrete defect needs reproduction.

- Static review found that Go and Rust reject any Choice/Noul legend, while the TypeScript/Python adapters accept and validate it. Existing Go/Rust legend tests cover Score only. The root assigned a focused correction and tests in the three Go/Rust files; the reviewed source and original reports remain intact. Exact current baselines were captured privately before editing.

- Independently read and hashed the exact original Git archive. All 40 read-only evidence checks passed; the TypeScript shared import is present in that source, and the native definitions have no application/runtime dependency.
- Added three focused test methods to each Go/Rust suite, then attempted the Rust before-fix condition in a separate fixture with offline dependency mode. The launcher failed before compilation because no default toolchain was configured. No dependency download occurred, and the result is not labeled a regression failure. Go is not available in the current command path.
- Changed only Go adapter.go, Go adapter_test.go and Rust src/lib.rs. Legend validation now supports all three primitive types, checks exact keys and requested descriptions, and preserves returned plain-Noul boundary descriptions when the request omitted criteria. The incremental patch and source hashes are in this folder.
- Reported the parent's broad non-JSON-input sentence to root for narrowing. This correction does not add transport-state validation or expand the adapter contract.
- Source is stable for root's isolated PR update. Fresh test/build evidence must name the new source commit; the original eight-check and Go/Rust results remain historical.
