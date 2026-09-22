# Typed runtime and configured toolkit

The version 2 runtime and configured CLI/MCP toolkit are ready for review on `nikhil-20260922-jevTypedRuntime`. The source is based on PR72 head `48ea2f6a35cf4d0ee4fcf3be4275af0aac2d392e`. The final tested source commit is `1b74f0f3acfa8b3f7461390c91674f51a9a0d389`. Nothing has been pushed or deployed.

## What changes

Version 2 preserves structured instructions and descriptions, boolean boundary criteria and ordinal level descriptions. `selected` stays modal; ordinal `expected` and boolean `probabilityTrue` retain their distribution-derived meaning. Responses preserve runtime identity, explicit unsupported/error/cancelled states and known or unknown accounting. Version 1 requests are rejected without a compatibility shim.

Configured `route_task` uses the lexical heuristic by default. An explicit hosted-Jev or local classifier uses the same selector policy. CLI, MCP and the configured TypeScript alias honor that selection and disclose it. Local adapter/revision identity and typed refusal messages/question IDs survive the public result. Unsupported input, errors and cancellation make no destination attempt. Hard spending limits and locality restrictions still apply before classification.

The Python Mac runtime, its example and tests are included because the configured bridge now sends version 2. Its installed models still support only string prompts and choice descriptions. Structured entries, boolean criteria and descriptive ordinal levels are refused. No model files, training dependencies, registry revisions or model-selection outcomes change here. Email usefulness is unproven by this source check.

## Source selection

[Selection inventory](selection.json) verifies the exact 52-file reviewed cutoff `aeaef7fd427813a28664b9d6429b94c917acef851ee4751636af505daa0c8fa9` before copying anything. Physically untracked current files were copied explicitly. Gateway, accounting, native decoding/Score and the model registry already match the base. The copied source adds 28 changed files from that inventory, the necessary Python/example/typecheck closure, and a relocated Python-to-TypeScript conformance test. Operational documentation and the verification driver are authored for this slice.

[Changed-source hashes](source-changes.json) enumerate all 42 changed files at the tested product/check commit. [The patch](source.patch) is the exact diff against PR72, SHA-256 `87a7a3cf4d8a7e81760439095c2f683016aa1f32c4161ee6c33f6ece391002f6`. Application UI, Music, app dependencies, web routing handler changes and publication transformations are outside this slice. The old version 1 review probes remain unchanged and are excluded from the active TypeScript project. Historical comparison and model-smoke runners retain their original version 1 source conditions.

## Exact archive checks

[Condition 02](checks-02/checks.json) passed all 11 steps against commit `1b74f0f3acfa8b3f7461390c91674f51a9a0d389` and tree `b5fff492552babf2a31491efb6ab0685f9804c38`. Its [source manifest](checks-02/source.json) and archive digest pin the inputs. The archive was extracted to an empty directory. Application frozen install and build ran before any sibling install, so existing sibling dependencies could not conceal a missing application dependency.

| Check | Result |
| --- | --- |
| Bun version | 1.3.14 |
| Application frozen install and build | Passed; sibling dependencies absent at build |
| TypeScript adapter and toolkit frozen installs | Passed |
| Both TypeScript projects | Passed |
| Native/runtime/routing/adapter and maintained gateway checks | 141 tests, 1,711 assertions, all passed |
| Python local contract checks | 20 tests passed, no MLX or weights |
| Verifier integrity checks | 3 tests passed |
| Fresh installed CLI/MCP | Passed after staged source removal; uninstall passed |

The [44 retained fixture records](checks-02/classifier-fixtures.jsonl) cover 17 CLI invocations and 27 MCP exchanges with authored responses. They vary classifications while keeping selector policy fixed, exercise hosted/local opt-ins, and verify unsupported input, malformed replies, cancellation, hard caps and refusal provenance. They are actual tool processes, not actual model calls. The installed check separately verifies baseline typed arithmetic, discovery, error flags, no-route responses and read-only lexical email behavior. It produced a 136,647-byte bundle with SHA-256 `ca748f8365429ca13a7480f712491902cb53e3317afbb9ba08ebee0cffd80aba`. Installed opt-in model inference and current real coding-client integration are outside this condition.

The inherited image-search preparation writes a new `document.manifest.prepared_at` in `visual-search/results.jsonl`. The verifier records that permitted generated metadata change with before/after hashes. It compares every other JSONL value and ordering, rejects other differences, and deliberately reports `sourceUnchanged=false`. Product code and nonvolatile inputs stayed unchanged.

## Retained failure and prior review

[Condition 01](checks-01/checks.json) remains a failed verification of initial product commit `f567926d983f8f2704a0fca2e71e585df8cb5fee`. App build, typechecks, Python and installation checks passed, but broad gateway-directory discovery loaded two historical independent suites requiring their own runner. It recorded 141 passes, two failures and two loading errors. Its blanket source-immutability check also reported the existing generated timestamp refresh. The follow-up commit changes only the verifier/tests and notes, explicitly naming maintained gateway targets and checking the exact allowed generated field. No runtime behavior was changed to obtain a passing result.

[Selected independent correction evidence](history/preserved.json) is preserved byte-for-byte. At its working-tree source52 cutoff, the same independent suite failed six of seven tests before correction and passed all seven after correction. Those original conditions and retained accounting/identity observations remain separate from this archived-source run. No historical model or client result is relabeled as current-source evidence.

## Reproduce

From a checkout containing the source commit:

```sh
python3 jev-experiments/typed-runtime-2026-09-22/verify.py \
  --ref 1b74f0f3acfa8b3f7461390c91674f51a9a0d389 --output /tmp/jev-typed-runtime-new-check
```

Use a new output directory. The verifier strips inherited provider credentials and runs only authored provider-free checks. The dedicated [CI workflow](../../.github/workflows/jev-typed-runtime.yml) uses the same exact-archive driver. CI has been authored, not observed on GitHub. No provider billing, routing-quality gain, performance, training completion, Mac inference or Vercel deployment follows from these checks. Earlier PR-owned Go/Rust/native and gateway sources remain unchanged; Go/Rust and model-export checks were not rerun.
