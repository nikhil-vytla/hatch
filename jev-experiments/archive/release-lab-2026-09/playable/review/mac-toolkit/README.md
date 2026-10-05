# Independent Mac toolkit and study review

The provider-free Mac and study suites passed all ten tests. Four additional fixture probes exposed defects in installation, wire responses, ordinal identity and cached-feature provenance. This review loaded no models, ran no GPU work, downloaded nothing and changed no Mac or training implementation files. Findings were sent to the root and training/runtime owner on 2026-09-20. The owner fixed all four, and an independent rerun confirmed the corrections in [probe-results-after-fixes.json](probe-results-after-fixes.json). The updated Mac suite has eight passing tests; the study suite has five.

This report records that review checkpoint. Later export, robustness and package-integrity changes are covered by the [training review](../training/README.md) and [default-promotion review](../default-promotion/README.md); current completion belongs to the [study release status](../../../training/release-status.json).

## Reproduced findings

| Priority | Finding | Evidence and suggested correction |
| --- | --- | --- |
| High | Model installation follows a pre-existing `.partial` symlink | A tiny fixture symlink pointed to an unrelated temporary file. Installation overwrote that file and promoted the symlink as the installed model. Use an exclusive fresh temporary file, reject symlink destination ancestry and verify the final path remains inside the model directory. |
| Medium | Pre-inference CLI failures do not satisfy the shared decision response | `decide` with a valid request and missing model returned only `status`, `issues` and `localOnly`. It omitted schema version, request identity, decisions, execution and timing. Preserve the parsed request ID and emit a full error response even when loading fails. |
| Medium | Small ordinal values lose identity | The valid scale `min=1e-11, max=2e-11, step=1e-11` became `[0, 0]` through decimal rounding. Preserve the shared contract's numerical identities, or return an explicit unsupported scale before inference. |
| High for research integrity | Resumed extraction can relabel stale feature tensors | With four pre-existing placeholder `.npz` files and a stale feature manifest, the extractor skipped every file and overwrote the manifest with the current corpus hash. Reject incompatible caches before any reuse; pin the extractor/model/corpus identities and verify metadata and row counts before fitting. |

[probe-results.json](probe-results.json) preserves the observed pre-fix outcomes. [probes.py](probes.py) reproduces them with temporary fixtures. The extraction probe supplies empty module stubs and a fake backbone, so it cannot invoke MLX or load a model. The installation probe uses three bytes of fixture content and a temporary sentinel file.

```sh
python3 jev-experiments/roadmap/playable/review/mac-toolkit/probes.py
python3 -m unittest discover -s jev-experiments/roadmap/mac -p 'test_local.py' -v
python3 -m unittest discover -s jev-experiments/roadmap/training -p 'test_study.py' -v
```

## Resolution

The installer now uses fresh temporary files and rejects symlink destinations; the unrelated sentinel stayed unchanged. Missing-model failures return the full decision envelope and preserve the request ID. Tiny ordinal values retain their identities. Extraction rejects the stale feature manifest without overwriting it. The installer also now checks the marker contents.

## Other conclusions and limits

- The only download path in `jev_local.py` is explicit model installation. `Runtime` checks the pinned files and loads the local tokenizer and MLX equations. The missing-model test proved it did not call the patched network function. Existing offline evaluation evidence additionally reports socket blocking during inference; this review did not rerun that model evaluation.
- Plain-text MIME parsing decodes headers and transfer encodings, excludes attachments and rejects HTML-only messages. The existing fixture proves byte-identical input preservation. Email-level limits and the stricter typed request/token limits are declared, so a large valid `.eml` can still be unsupported for inference.
- The uninstall code requires the exact toolkit marker, refuses root/home/current-directory targets and checks known model filenames before optional deletion. No uninstall was run outside temporary fixtures by this review. The installation guard now checks the exact marker contents as well.
- At this checkpoint, recipe and temperature selection read training/validation features. Test and transfer rows entered subsequent evaluation. No test-driven default selection was found, and the published state was `defaultSelected: false`.
- The initial Core ML export aggregated validation, test and transfer agreement. This review requested a separate validation-only eligibility gate before default selection. It was a missing gate, not an observed leaked selection; the later reviews above inspect its correction.
- The initial MLX robustness report excluded residual-readout arithmetic from timing and checked frozen outputs for batch independence. It did not establish complete adapted decision-level timing and batch evidence. Later measurement scope belongs to the training owner's evidence.
- The initial training backbone loader did not recheck recorded model hashes before reading cached files. This review requested provenance safeguards for weights and features; later checks are recorded in the training review.

Physical installation, real inference, model quality and frame-time measurements remain the implementation owner's evidence. Passing these provider-free checks does not establish the broader release gate.
