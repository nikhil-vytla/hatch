# Portable independent-review rerunners

- Replace task-specific temporary-pointer lookup with explicit archive/output arguments. Keep historical results immutable, preserve exact executed driver versions privately, and distinguish executed-driver hashes from unexecuted published rerunners. Verify argument/preflight behavior only.

- Preserved exact executed v2/v3 driver bytes and the prior manifests before editing. The published scripts now require `--archive` and `--output`, verify the pinned archive and selected source hashes, refuse existing destinations and archive-contained outputs, and offer read-only `--preflight-only`.
- Kept all historical test bodies, observations, logs and review-check records unchanged. For v2, the existing observations script is copied byte-for-byte into the new output directory so its relative output cannot overwrite the original observations.
- Ran 20 argument/preflight checks across the two scripts: required arguments, help, existing files/directories/dangling symlinks, missing archive, wrong archive identity, changed selected source, archive-contained output, and successful preflight with no output creation. All passed. No Bun suite was executed by this maintenance task.
- Added per-review driver provenance and refreshed review manifests with separate historical-executed and newly-published driver hashes. README wording distinguishes the original runs from unexecuted rerunners and preserves the historical meaning of the earlier v2 identity check.
