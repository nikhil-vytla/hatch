# Native questions in four language adapters

Structured instructions and candidate descriptions now survive the Python, TypeScript, Go and Rust adapters. Choice keeps its named candidates, Noul accepts explicit true/false boundaries, and Score accepts ordered descriptions while preserving fractional expected values. Invalid annotations and non-JSON question descriptions fail before transport instead of being coerced into another question.

This source slice introduces the shared TypeScript native definitions and updates each adapter's compiler, decoder and tests. It does not include the later decision-runtime envelope or application redesign. Those consumers remain separate release work.

## Source and behavior

- [Native definitions](../packages/decision-runtime/src/native.ts) preserve strings, objects, arrays and null, with bounded JSON validation. Nested booleans and numbers remain JSON values; they are not accepted as entire description entries.
- [TypeScript](../adapters/typescript/index.ts), [Python](../src/jev_lab/semantic.py), [Go](../adapters/go/adapter.go) and [Rust](../adapters/rust/src/lib.rs) accept the explicit `x-jev-instructions`, `x-jev-criteria` and `x-jev-levels` annotations. Unknown or misplaced annotations are errors. Two-level Score retains Score semantics rather than being mistaken for Noul.
- Distribution and legend checks preserve question identity and description structure. Noul's optional distribution must agree with its scalar probability. Python retains Score's expected value separately from its most probable level.
- Choice supports 2–255 entries and Score 2–10 levels. These are interface bounds, not evidence that every permitted task performs well.

The current source commit is `c219f57266d2e8905c66212a181fac3bd8c236ac`, based on publication-lineage PR #70. [source-v2.json](source-v2.json) records the selected paths, hashes and archive identity. [source-code-v2.patch](source-code-v2.patch) contains only authored source and CI changes. The original source record and patch remain unchanged as the first condition.

## Independent review and correction

The [independent review](review/README.md) verified all 40 retained source/evidence checks, then found a contract gap: Go and Rust rejected every non-null Choice or Noul legend, including a correct structured legend. Their initial green tests did not cover this behavior. The correction validates the complete requested key set and native entry shapes, compares descriptions when the question specifies them, and preserves the accepted metadata.

Three new methods in each language exercise matching and mismatched descriptions, missing/extra keys, plain Noul boundaries and generated Choice labels. The [before-fix fixture](legend-regression.json) uses the original implementation with the new tests. Both language suites executed and failed; the [fixed suites](adapters-v2.json) pass. The earlier unavailable-toolchain attempt remains a separate launcher failure in the review. Transport-state validation through arbitrary custom transports is outside this adapter slice; the description validation claim above is deliberately narrower.

## Verification

The [exact-source verifier](verify_source.py) extracted that commit with no working-tree overlays. All eight [build and contract checks](verification-v2.json) passed. The application built before sibling dependency installation, matching the deployment's build order.

| Check | Result |
|---|---|
| Application frozen install and production build | Passed |
| TypeScript frozen install and type check | Passed |
| Native JSON and TypeScript adapter tests | 9 passed, 41 assertions |
| Python frozen development install and contract tests | 59 passed, 1 skipped |
| Go adapter tests | Passed; demo package has no tests |
| Rust adapter tests | 13 passed; binary and documentation targets have no tests |
| Publication integrity | All 45 records passed |

[Go/Rust evidence](adapters-v2.json) uses the same exact archive, temporary official toolchains and caches, and checks unchanged adapter source and global configuration. The Python suite's optional dependency condition remains a skip; this report does not count it as a passing test. Commands and versions are retained in the records. No hosted inference, training, performance measurement or real-client integration was requested. Package installation could reach public registries.

The new `Jev native questions` workflow runs the adapter checks on pull requests and main. The existing scene workflow covers the app build. Their remote outcomes will be checked on the pushed head separately. This report proves local source behavior, not release completion or canonical deployment.
