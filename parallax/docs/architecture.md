# Architecture and invariants

Status: implemented for the GSM8K domain and native-verifier core.

## Record flow

1. `DomainSourceIdentity` identifies a GSM8K source URI, immutable revision, split, and row ID.
2. `AssetManifest` commits every admitted asset by relative name, byte count, SHA-256, origin, revision, and license.
3. `PublicTaskIdentity` binds source, prompt, and public asset manifest. It is safe to publish.
4. `VerifierCommitment` binds the loaded evaluator, parser, and shared answer-validator code objects, their policies, answer authority, assets, exact Python runtime identity, dependencies, and schemas.
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

The grading API accepts task data, submission text, and committed asset bytes.
It has no evaluator, parser, digest, result-routing, or runtime callback
parameter. Commitments fingerprint loaded CPython evaluator, parser, and answer
validator code objects plus the implementation name, patch version, cache tag,
and semantic policies. These commitments are reproducibility and integrity
evidence for a trusted controller. They are not process isolation and do not
defend against monkeypatching or code-object mutation inside that process.
Admission also requires exact equality for sealed identity, asset manifest,
public asset reference, and available asset names and bytes.

One canonical answer validator governs authority construction, commitment,
admission, parser output, and grading. It accepts `0` or an optional minus
followed by a nonzero ASCII digit and up to 99 further digits. It rejects
padding, a plus sign, leading zeros, negative zero, non-ASCII digits, and more
than 100 digits. A wrong integer is `task_failure`; malformed or ambiguous
model output is `invalid_submission`; admission and asset faults are
`harness_failure`; unexpected parser or evaluator faults are
`verifier_failure`.

## Publication and replay invariants

Publication accepts identity records, derives immutable public bytes, and
writes its own same-filesystem staging directory. It opens directories and
files relative to no-follow descriptors, fsyncs each file, captures and checks
the staging tree, atomically renames it, then captures the visible destination
again before issuing a receipt. A failed rename leaves no destination. A
post-rename validation failure raises `PublicationStateError`, which explicitly
reports that a destination is visible and durability is indeterminate.

If parent-directory fsync fails after rename, the API raises
`PublicationDurabilityError` with the verified receipt and snapshot. The
destination is complete and visible, but crash durability is indeterminate.

The public tree policy explicitly allows `publication-manifest.json` and
`task.json`, ignores no paths, and rejects every unexpected file or directory.
Traversal rejects symlinks and non-regular entries. Each file is opened with
no-follow semantics and read once; descriptor metadata must remain stable
during capture. Replay derives the snapshot, verifies the manifest, and returns
bytes from that same capture. Receipt, snapshot, and actual replay policy IDs
must match.

Protected roots are traversed lexically from the filesystem root. Every path
component is opened relative to the previous directory descriptor with
`O_NOFOLLOW|O_DIRECTORY`; no component is resolved through a symlink.
Symlinked parents and roots fail closed. A publication destination's parent
must already exist so publication never creates directories through an
unverified ancestor.

Paths use canonical forward slashes. Validation rejects absolute and parent
paths, empty and dot components, backslashes, Windows drives and reserved
device names including superscript-numbered COM/LPT forms, trailing dots or
spaces, alternate data-stream colons, wildcard characters, ASCII control
characters, NUL, and non-NFC text.

## Trust boundary

> [!IMPORTANT]
> Parallax assumes a trusted controller and evaluator Python process.
> Agent-controlled task data, submissions, artifact trees, and workspaces are
> untrusted and may race or mutate. Agent code must not execute in or
> monkeypatch the evaluator process.

This core authenticates supplied bytes and records loaded verifier semantics
for reproducibility. It does not establish that a mutable dataset URL still
serves those bytes, perform provider-backed construction, prove Evolving Intent
compatibility, or isolate hostile code.

> [!WARNING]
> A valid content commitment proves which bytes were admitted. It does not
> prove that caller-supplied source or answer bytes came from the claimed
> dataset revision; audited ingestion remains a separate requirement.

> **TODO:** Add audited dataset ingestion before producing non-synthetic tasks.

> **TODO:** If a runtime must execute hostile code near grading, add a separate
> verifier process, container, or capability boundary before admitting that
> runtime. Pure Python commitment checks are not that boundary.
