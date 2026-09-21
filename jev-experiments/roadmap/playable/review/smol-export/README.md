# Independent Smol Core ML artifact verification

Both completed Smol seed 17 comparison streams reproduce their reported counts, coverage, maximum probability delta and argmax agreement exactly. The independent [verification script](verify.py) checked 5,920 public rows against the original cached MLX and Core ML predictions without importing model libraries or invoking inference. No consequential defect was found within this scope. [verification.json](verification.json) retains the computed results and source hashes.

| Split | Rows per compute condition | CPU_ONLY maximum delta | ALL maximum delta |
| --- | ---: | ---: | ---: |
| Validation | 192 | 5.0067901611328125e-6 | 2.950429916381836e-6 |
| Held-out test | 384 | 4.32133674621582e-6 | 2.771615982055664e-6 |
| Transfer | 2,384 | 5.692243576049805e-6 | 4.082918167114258e-6 |
| All comparisons | 2,960 | 5.692243576049805e-6 | 4.082918167114258e-6 |

Coverage and argmax agreement are 100% in every split and compute condition. The agreement figure compares the exported graph with MLX; it does not establish accuracy against reference labels. Transfer retains all 400 Typed Decisions cases and their 2,000 questions, plus 128 examples each from CLINC, MultiRC and SummEval. Row identities, semantic option order and split order match the frozen manifest, with no duplicate or missing IDs. Probabilities are finite, bounded and normalized, and every retained per-row delta/agreement flag matches independent arithmetic.

## Provenance and publication

The review recomputed SHA-256 values for both public streams, both original Core ML streams, all nine seed/split MLX prediction files, three retained/cached Smol readouts, the protocol, corpus/source/model manifests, three evaluated corpus files, eight feature-cache files, all eleven pinned Smol backbone files, the three exported package files and the prepared timing input. All expected hashes and byte counts match. The package totals 1,453,684,439 bytes and remains in the ignored cache; no model or source dataset was copied into this review folder.

The published Smol export equals [export-smol-17.json](../../../training/export-smol-17.json), including its provenance and isolated timing annotations. Publication links both comparison streams. The [UI asset glob](../../../training/TypedDecisionStudy.tsx:60) includes them, and the [download controls](../../../training/TypedDecisionStudy.tsx:330) label CPU and automatic hardware conditions separately. This source review did not click the downloads or infer Neural Engine placement from `ALL`.

## Retained content and timing labels

Every public row contains exactly eight fields: `id`, `split`, `values`, `status`, `mlxProbabilities`, `coremlProbabilities`, `maxProbabilityDelta` and `argmaxAgreement`. Source passages, instructions, questions, prompts and gold distributions are absent. Dataset IDs and semantic option IDs are intentionally retained to make probability positions interpretable; string option IDs are at most 48 characters and match the original cached identities. The [publication transform](../../../training/export_decision_rows.py:35) uses an explicit field list rather than serializing the full source row.

The [public timing paragraph](../../../training/TypedDecisionStudy.tsx:195) states that native MLX includes tokenization and readout, while Core ML uses prepared inputs padded to 768 tokens. It also limits the timing claim to one short validation input. The saved export labels input preparation as excluded; isolated measurements additionally disclose the fresh process and unflushed operating-system/compilation caches. [benchmark_coreml.py](../../../training/benchmark_coreml.py:19) reads prepared tensors before timing, records package load separately, then times first and warm `predict` calls. The review checked these boundaries in source; it did not rerun any timing measurement.

## Reproduce and limits

```sh
python3 jev-experiments/roadmap/playable/review/smol-export/verify.py
```

The script uses only Python's standard library and requires the existing ignored Smol study/model cache for full provenance verification. It writes only its local verification report. Saved data and hashes establish consistency of the retained evidence; they do not independently prove execution timestamps, hardware placement, dataset licensing or model quality. Package-description bytes were hash-verified against the recorded package; the embedded protobuf metadata was not parsed again. No Qwen or Laya artifacts, training files, root documents or product code were changed.
