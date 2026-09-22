# Explicit benchmark publication lineage

RewardBench2's committed display record now identifies itself as a derivative and retains the SHA-256 of its exact predecessor. The runner applies the same transform to complete results and partial checkpoints. Preparation is idempotent, and validation rejects missing lineage, changed candidate hashes, ambiguous rows and inconsistent projection metadata. Recorded labels, scores, request accounting and aggregate metrics remain unchanged.

This slice follows [PR #69](https://github.com/nikhil-vytla/hatch/pull/69). Its source commit is `01150680f6a11fb40efd324318f584da58bd8972`. The [code patch](source-code.patch) covers authored code and workflow changes; the result record carries its own lineage marker. The committed derivative is not represented as an original evaluation record or upstream dataset.

The exact source-commit Git archive passed a frozen Bun install, the application build, **25 tests with 113 assertions**, and the full **45-publication** JSONL/output check. No untracked source, generated output or dependency overlay entered that archive. [Verification](verification.json).

The earlier isolated-checkout build and focused tests also passed. The full benchmark validator passed separately with the pinned upstream dataset already available locally, reconstructing the predecessor digest and preserving 1,865 rows and 8,977 candidates. That cache-dependent validation is separate from the clean-build gate and does not represent new model execution. The generated [validation record](../rewardbench2/validation.json) retains counts and metrics.

The workflow now runs the derivative tests and checks every publication after building. GitHub checks and deployment must be read at their own exact revision.
