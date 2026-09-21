# Independent delivery slice review

No source or asset omission was found in the completed five-slice delivery. The actual [assembler](../../../delivery/assemble.py) copied every slice into a disposable Git directory without staging. The [independent check](verify.py) verified copied bytes, source/download dependencies, exclusions and exact patch replay. [verification.json](verification.json) retains the snapshot and file hashes; later files or edits require root's final assembly check.

| Check | Observed result |
| --- | --- |
| Five slices | Runtime, routing, training, playable and integration all copied successfully with `staged: false`. The retained run contains 556 files; this count is a dated snapshot, not a permanent release total. |
| Selected ignored images | All 20 paths in the reviewed image manifest were copied. The 14 additional final-review PNGs were also selected. |
| Checkpoints | All nine authored readouts were copied with matching manifest hashes and byte counts: three Laya, three Smol and three Qwen seeds. Combined size is 610,287 bytes. No other weight file was selected. |
| Binary limit | All 43 selected binaries are under 2,000,000 bytes. The largest is 334,018 bytes. |
| Exclusions | No cache, dependency/virtual-environment tree, fetched repository, `.local.` file, `.log`, archive, model package or large model weight was selected. Public harness transcripts remain intentional evidence; the selected text produced no high-confidence credential-pattern matches. |
| Imports and downloads | 342 resolved literal module/URL references and 25 glob matches resolve to selected files or the existing Git base, with the two generated inputs explained below. Both the Mac installer source list and its bundled default readout are present. |
| Application patch | Exact byte match with current tracked changes plus the new `api/route.ts`. It checked and applied in the disposable directory, producing byte-identical copies of all 23 current files. |

The patch is 96,121 bytes, SHA-256 `58663d91310786d13c375119324d3ab74bf0eaccc9ba98b548f08780ce55ce74`. It includes all 22 changed tracked files and the new routing API entry, including the latest materials/Tetris evidence-download imports and current shared interface integration.

Two existing imports deliberately consume ignored generated files: `live-worlds/crowd/demo.json` and `live-worlds/ghost-brush/examples.json`. Their JSONL/manifest sources and [generator](../../../../live-worlds/prepare.ts) are Git-tracked. The patched preparation script calls that generator before TypeScript/Vite in the existing build command. They are therefore build outputs, not delivery omissions; this review did not copy local prepared JSON into the temporary repository.

The remaining unresolved literal scanner matches are two directory URLs, fourteen retained harness test artifacts that refer to their original fixture's `sum` module, and two strings used to create test fixtures. They are not missing application modules. Those exact matches are preserved in the verification result, rather than silently discarded.

## Reproduce and limits

```sh
python3 jev-experiments/roadmap/playable/review/delivery/verify.py
```

The probe initializes a temporary Git directory, exercises all five slices without `--stage`, reconstructs only the patch's base files from Git, applies the patch there and removes the directory afterward. It writes only this review's verification JSON. No delivery/product source, user index or Git history was changed; no dependencies were installed and no model, browser, build or performance run was invoked.

This is a source-selection and static dependency audit, not the final assembled-branch build. Existing tracked project files and the documented preparation step remain part of the delivery contract. Static matching does not evaluate arbitrary computed download paths, and credential patterns are not a forensic privacy guarantee. Root owns the final build, CI, PR publication and deployment checks after any review changes.
