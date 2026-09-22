# Independent gateway correction review

Accept the three source corrections at `d93be44fde84ac83992eaa1c7ca2b1f8359aa99d` within this bounded review. The earlier cancellation, phantom-attempt and partial-usage findings are resolved, and no remaining consequential gap was found in the correction paths. Corrected-head remote CI execution remains a separate gate; the remote state observed here still points to the older v2 report head.

All ten selected hashes match [source-v3.json](../source-v3.json), Git source and the exact corrected archive. The archive hash, five verification-log hashes and verifier hash match the retained v3 verification. The six maintained regression bodies are byte-identical to the prior independent tests after the import/source-loading header; their shared body hash is `9f43a309891371290e8043b71b834c1ad19d086e93002c5bdc3f81350e2ee11c`. At the correction review, every file in the [v2 review](../independent-review-v2/README.md) matched its frozen manifest. Later portability maintenance updates only rerunners and their documentation/provenance; the historical tests, observations and logs preserve four failures and two controls against the earlier source.

| Correction | Independent result |
| --- | --- |
| Cancellation in final `onAttempt` or `onAccounting` | Rejects with `cancelled`/499 and preserves the observed charge, usage, model and generation identity. Paid or unknown earlier attempts remain intact. |
| Pending observer throws or aborts | The unsent attempt is removed. Before any dispatch the error has zero attempts and zero cost; after an earlier attempt its original accounting remains. |
| Partial token counts contradict a known total | Both input-above-total and output-above-total are flagged. Valid partial counts and explicit zero survive; missing fields are not inferred and the independent charge remains known. |

The seven explicit maintained targets independently pass **38 tests / 981 assertions**. [correction-boundaries.test.ts](correction-boundaries.test.ts) adds three groups covering 18 authored boundary cases and passes **164 assertions**. See [review-checks.json](review-checks.json) and the sanitized logs. Native question validation, Score and composition source bytes are unchanged from v2; the maintained suite still exercises the independent Score vertex oracle and existing transport contracts.

The workflow explicitly lists seven `.test.ts` targets, including `observer-usage.test.ts`, and matches the verifier's targets. This keeps the preserved failing v2 review fixtures out of ordinary CI while executing identical maintained regression bodies. [verification-closure.json](verification-closure.json) confirms successful exact-archive install/build/test/publication checks. [remote-checks.json](remote-checks.json) records the older remote head observed during review; it does not close corrected-head CI.

No product files were edited and no provider calls were made. Tests used authored responses plus the existing ephemeral loopback redirect fixture. This disposition covers the pinned correction, not provider quality, live billing accuracy, deployment or later source changes.

## Rerunning without changing recorded evidence

```sh
python3 run-review.py --archive path/to/verified-archive --output path/to/new-results --preflight-only
python3 run-review.py --archive path/to/verified-archive --output path/to/new-results
```

The archive directory must contain the pinned `source.tar` and its dependency-prepared `source/`, as produced by the owner verifier. The rerunner checks the archive digest and selected extracted-source hashes; it performs no installation. An existing output file, directory or symlink is refused. Preflight creates no output; a real rerun writes logs, observations where applicable and provenance only into the new destination.

Historical recorded results were produced by driver SHA-256 `9cf539fc617c903b08a04b9c39cc43020f725a06f4d701ebc1e9cc77cb4fe0c9`. The published rerunner is `97fd5ba6e7a3bb949c5bdf5fc50bdc44570afce62127169f4861a45e78d3c103` and has been checked only for argument/preflight behavior; it did not produce those retained results. [driver-provenance.json](driver-provenance.json) binds both versions to their appropriate records.
