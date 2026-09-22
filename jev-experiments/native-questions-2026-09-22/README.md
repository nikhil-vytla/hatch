# Native questions in four language adapters

Structured instructions and candidate descriptions now survive the Python, TypeScript, Go and Rust adapters. Choice keeps its named candidates, Noul accepts explicit true/false boundaries, and Score accepts ordered descriptions while preserving fractional expected values. Invalid annotations and non-JSON inputs fail before transport instead of being coerced into another question.

This source slice introduces the shared TypeScript native definitions and updates each adapter's compiler, decoder and tests. It does not include the later decision-runtime envelope or application redesign. Those consumers remain separate release work.

## Source and behavior

- [Native definitions](../packages/decision-runtime/src/native.ts) preserve strings, objects, arrays and null, with bounded JSON validation. Nested booleans and numbers remain JSON values; they are not accepted as entire description entries.
- [TypeScript](../adapters/typescript/index.ts), [Python](../src/jev_lab/semantic.py), [Go](../adapters/go/adapter.go) and [Rust](../adapters/rust/src/lib.rs) accept the explicit `x-jev-instructions`, `x-jev-criteria` and `x-jev-levels` annotations. Unknown or misplaced annotations are errors. Two-level Score retains Score semantics rather than being mistaken for Noul.
- Distribution and legend checks preserve question identity and description structure. Noul's optional distribution must agree with its scalar probability. Python retains Score's expected value separately from its most probable level.
- Choice supports 2–255 entries and Score 2–10 levels. These are interface bounds, not evidence that every permitted task performs well.

The source commit is `c89327f7f94a7c70551485ffa0a132ee8640c715`, based on publication-lineage PR #70. [source.json](source.json) records the selected paths, hashes and archive identity. [source-code.patch](source-code.patch) contains only authored source and CI changes.

## Verification

The [exact-source verifier](verify_source.py) extracted that commit with no working-tree overlays. All eight [build and contract checks](verification.json) passed. The application built before sibling dependency installation, matching the deployment's build order.

| Check | Result |
|---|---|
| Application frozen install and production build | Passed |
| TypeScript frozen install and type check | Passed |
| Native JSON and TypeScript adapter tests | 9 passed, 41 assertions |
| Python frozen development install and contract tests | 59 passed, 1 skipped |
| Go adapter tests | Passed; demo package has no tests |
| Rust adapter tests | 10 passed; binary and documentation targets have no tests |
| Publication integrity | All 45 records passed |

[Go/Rust evidence](adapters.json) uses the same exact archive, temporary official toolchains and caches, and checks unchanged adapter source and global configuration. The Python suite's optional dependency condition remains a skip; this report does not count it as a passing test. Commands and versions are retained in the records. No hosted inference, training, performance measurement or real-client integration was requested. Package installation could reach public registries.

The new `Jev native questions` workflow runs the adapter checks on pull requests and main. The existing scene workflow covers the app build. Their remote outcomes will be checked on the pushed head separately. This report proves local source behavior, not release completion or canonical deployment.
