# Architecture and invariants

Status: implemented for the GSM8K domain and native-verifier core.

## Record flow

1. `DomainSourceIdentity` identifies a GSM8K source URI, immutable revision, split, and row ID.
2. `AssetManifest` commits every admitted asset by relative name, byte count, SHA-256, origin, revision, and license.
3. `PublicTaskIdentity` binds source, prompt, and public asset manifest. It is safe to publish.
4. `VerifierCommitment` binds executable evaluator and parser source bytes, both policies, answer authority, assets, runtime policy, dependencies, and schemas.
5. `SealedTaskIdentity` binds the public task and all reward-affecting verifier data.
6. Admission recomputes the local verifier commitment and exact asset set before evaluation.
7. `GradeResult` returns a closed verdict and content-addressed evidence ID.
8. `PublicationReceipt`, `TreeSnapshot`, and `ReplayLock` prove which public bytes became visible and which verifier and asset commitments must be present for replay.

## Identity invariants

Canonical encoding accepts only null, booleans, signed 64-bit integers, NFC strings, string-keyed maps, and ordered sequences. It rejects floats and native path or byte objects. JSON object keys are sorted, whitespace is absent, and UTF-8 is used directly.

Every ID preimage has this form:

```text
"parallax-content-id" NUL "v1" NUL namespace NUL canonical-record-bytes
```

The displayed ID records the version, namespace, algorithm, and lowercase digest. Schema fields remain inside committed records, so a record schema change also changes identity.

Public identity must remain unchanged when only answer authority changes. Sealed identity must change if answer authority, evaluator, parser, runtime policy, relevant assets, or any sealed evaluator data changes. Public files may contain only the public record and its publication manifest.

## Admission and grading invariants

The local implementation recomputes the evaluator and parser source-byte digest. An evaluator label alone never authorizes execution. Admission requires exact equality for the verifier commitment, sealed identity, asset manifest, public asset reference, and available asset names and bytes.

The parser accepts one final non-empty `FINAL_ANSWER` line with a canonical decimal integer. The evaluator performs canonical string equality. A wrong integer is `task_failure`; malformed or ambiguous model output is `invalid_submission`; admission and asset faults are `harness_failure`; unexpected parser or evaluator faults are `verifier_failure`. The grading boundary converts these failures to `GradeResult` and does not report them as model task failures.

## Publication and replay invariants

Publication writes complete files to a same-filesystem staging directory, fsyncs each file, checks canonical bytes and the committed manifest, snapshots the tree, and atomically renames the directory into place. A failed rename leaves no destination.

The public tree policy explicitly allows `publication-manifest.json` and `task.json`, ignores no paths, and rejects every unexpected file or directory. Snapshot traversal rejects symlinks and non-regular entries. Snapshots commit relative paths, byte counts, and content digests; file modes, owners, and timestamps are intentionally outside identity. Relative path validation rejects absolute paths, `..`, empty segments, and non-normal POSIX forms.

Replay succeeds only when the current snapshot equals the locked snapshot, publication bytes remain canonical, and task admission succeeds with the locked verifier and assets. It returns the exact published bytes and never regenerates identity-bearing content.

## Trust boundary

This core authenticates supplied bytes and verifier logic. It does not establish that a mutable dataset URL still serves those bytes, perform provider-backed construction, or prove Evolving Intent compatibility. Callers must obtain public source assets and an answer authority through a separately audited ingestion path before building production tasks.

## Evidence-branch disposition

The implementation retains deterministic canonical bytes, domain-separated
content IDs, source pins, individual asset provenance, public and sealed
identity, native verifier authority, closed grading outcomes, atomic
publication, and locked replay. These concepts were rewritten as the small
standard-library package under `src/parallax/`.

It rejects the evidence branch's fake Evolving Intent records, universal
variant catalog, hand-authored proposal fixtures, campaign runner, checkpoint
placeholders, HUD adapters, Click recipes, and experiment execution. None of
those types or compatibility paths are part of this package.

> [!WARNING]
> A valid content commitment proves which bytes were admitted. It does not
> prove that caller-supplied source or answer bytes came from the claimed
> dataset revision; audited ingestion remains a separate requirement.
