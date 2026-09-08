# Milestone 2: storage and pure verification

Implemented the new local storage format and pure protocol verifier on the
frozen Milestone 1 contracts. Guarantee 5 now runs and passes. No contract type,
legacy implementation, git history, or dependency declaration was changed.
There was no commit or PR.

## Files

| Created | Purpose |
|---|---|
| `src/strive/vnext/codec.py` | Canonical closed serialization, strict field decoding, typed reference traversal, opaque annotation construction |
| `src/strive/vnext/wire.py` | Frame transport, record digests, producer grants, producer MAC and supervisor seal |
| `src/strive/vnext/errors.py` | Verification, corruption, incomplete-tail, and lease failures |
| `src/strive/vnext/store/{__init__,cas,journal}.py` | New root, durable CAS, journal reader, protected setup, leased writer and producer ports |
| `src/strive/vnext/verify/{__init__,engine}.py` | Pure preflight, full replay, immutable effects/results/revisions/accounting |
| `tests/vnext/storage_fixtures.py` | Small authority history with retained artifacts |
| `tests/vnext/test_storage_verification.py` | Round-trip and adversarial tests |
| `tests/vnext/fresh_probe.py`, `test_verifier_only.py` | Guarded fresh interpreter replay |
| This folder's `NOTES.md`, `README.md`, `_summary.md` | Investigation notes and handoff |

Updated `tests/vnext/test_acceptance_contracts.py` to implement
`StorageRuntimeDriver` for guarantee 5 and remove only that strict-xfail marker.
Updated `src/strive/vnext/README.md` to describe the implemented API.

## Format and durability

The default root is `artifacts-vnext`, separate from legacy `artifacts`:

```text
artifacts-vnext/
  FORMAT                       strive-vnext-store/1
  objects/<sha256 hex>          immutable content
  runs/<run-id>/
    authority                  protected producer identities and local MAC keys
    lease                      stable inode with exclusive POSIX flock
    epoch                      monotonically increasing writer epoch
    journal                    ordered framed commits
```

CAS publication writes a temporary inode, flushes and fsyncs it, links it into
the object directory without replacing existing content, and fsyncs directory
entries. Append preflights against an in-memory payload overlay before changing
files, publishes the payload, and verifies/fsyncs every referenced object before
writing the journal. It returns only after the journal fsync succeeds. Failed
publication can leave unreferenced objects, never committed dangling references.

Each frame has magic, bounded length, canonical commit bytes, a SHA-256 checksum,
and a commit trailer. Its authenticated envelope carries monotonic sequence,
unique record identity, payload hash, and the previous record digest. The record
digest covers epoch, append path, and all envelope fields with the self-digest
slot neutralized. Integrity-link digests name records, not CAS objects.

A second writer fails at nonblocking flock. Every append checks the acquired
PID, lease inode, current persisted epoch, and caller epoch. Closing a writer
waits for any active append before releasing the lease. Reopening a writer
re-verifies history before durably increasing the epoch. An append interruption
closes that writer. Partial frames raise `IncompleteTail(offset)`; damaged
commits raise corruption errors. There is no automatic truncation or repair.

## Authority and pure verification

`ProducerPort` derives identity from trusted setup. The verifier checks it
against the protected run authority and `RECORD_OWNERS`, then verifies both the
producer MAC and supervisor seal. Producer implementations are checked against
RunBinding pins. A correct producer string and recalculated hashes cannot
replace authentication. Keys remain outside CAS and candidate inputs. This is
local authentication under the design's trusted-host assumption, not public-key
attestation or protection from replacing the entire host trust root.

`preflight` consumes an already-verified immutable prefix, one frame, and
read-only dependencies, returning a new state or raising. `replay` applies it
to the whole journal. State retains exact records, bundles, revision IDs,
private state, environment, pending commands, result cursors, measurements,
measured usage, outstanding obligations, and overruns. Replay never dispatches.
The writer replays the existing history before appending, so newly missing or
corrupt old artifacts also stop mutation. Persistent caches are deferred.

The fresh interpreter uses `python -I -B`, an exact allowlist of neutral strive
modules, forbidden heavy-dependency imports, and an audit hook rejecting writes,
sockets, and process dispatch. It verifies a real disk history containing
candidate source bytes without executing them. A separate child rejects the
same history after a result reference is corrupted. Test-side process launch
is solely the requested fresh-interpreter isolation; production code launches
no processes. Artifact snapshots also verify that replay leaves files unchanged.

## Acceptance map

All names below are in `tests/vnext/test_storage_verification.py` unless noted.

| Required case | Test |
|---|---|
| Publish + RunBinding, authorization/settlement pair, activation, continuation, annotation; reconstruct state | `test_round_trip_publish_append_verify_and_replay` |
| Missing/corrupt artifact | `test_required_artifact_missing_or_corrupted_stops_reads_and_appends` |
| Tampered chain and record digest/checksum | `test_tampered_record_hash_chain_rejected_even_with_valid_mac`; `test_record_digest_and_commit_checksum_are_checked` |
| Illegal lifecycle transition, failed preflight leaves prefix unchanged | `test_illegal_transition_fails_preflight_and_replay_without_mutating_state` |
| Forged producer and wrong owner | `test_forged_producer_identity_and_wrong_owner_port_are_rejected`; `test_producer_name_and_hash_are_not_authentication` |
| Duplicate result consumption, append and replay | `test_second_result_consumption_is_rejected` |
| Second writer, stale epoch/old writer | `test_second_writer_and_stale_epoch_are_rejected`; `test_new_epoch_rejects_stale_return_and_requires_reconciliation`; `test_close_cannot_release_lease_during_an_append` |
| Torn final frame, no implicit recovery | `test_torn_final_frame_requires_explicit_recovery`, seven cuts |
| Unknown bounded annotation remains opaque | `test_unknown_bounded_annotations_are_opaque_and_never_authority` |
| Fresh interpreter imports no candidate/heavy code and writes nothing | `test_verifier_only.py::test_fresh_interpreter_verifier_is_read_only_and_candidate_free` |
| Runtime guarantee 5 closed | `test_acceptance_contracts.py::test_runtime_integrity_5_replay_rejects_corruption_without_candidate_imports` |

Additional tests exercise malformed committed fields, causation, required nested
command references, pending-command consistency, budget settlement, retained
unknown obligations after consumption, late receipts after finish, overrun
recording and stopped dispatch, controller handover, scorer ownership, separate
return/settlement cursors, content identity versus execution identity, staged
harness authorization, and publication/journal fsync failure boundaries.

## Decisions where the frozen types leave details open

- The initial revision ID is the RunBinding record ID; each activation's record
  ID becomes the next revision ID. Activation checks the exact previous bundle
  and expected revision. Controller state activates atomically, only after old
  results are consumed. ApplyChange and RestoreBundle match their pending command.
- A combined observation/settlement record folds a legal transition to RETURNED
  followed by RETURNED to SETTLED. Separate records also work. There is no new
  lifecycle shortcut. Consumption requires SETTLED and retains the original
  return cursor.
- Usage observations are cumulative per effect/resource. Explicit measured
  zeroes remain known. Measured components replace reservations; missing components retain their obligations. Duplicate
  resources, disappearing usage, erased unknown bounds, and false release fail.
  Late accounting stays in SETTLED or CONSUMED, requires reconciliation evidence,
  cannot change a result/environment, and must actually update accounting. It
  does not transition or redeliver a consumed result.
- A second harness-stage authorization may advance HARNESS_LAUNCH to
  UPSTREAM_FORWARD under the same effect/command/invocation/epoch, preserving
  the reservation and request identity. Only the stage and retained actual
  provider request may change. It creates no second reservation.
- A returned observation must use the current writer epoch. After reacquisition,
  an old effect can be reconciled under the new epoch with explicit evidence;
  the old authorization cannot be used to redispatch it.
- The frozen Annotation constructor remains unchanged. Storage reuses that
  dataclass while bypassing its JSON parser and retaining namespace/byte bounds.
  Neither annotation content nor arbitrary strings are interpreted as references.
- A run has one pinned scope and producer binding per producer kind. The trusted
  runtime owns setup/supervisor ports, the gateway owns the broker port, and the
  retained adapter/scorer pins own their ports. Candidate annotations use a
  separate registered port. Milestone 3 must enforce who receives those handles.
- An empty journal is a valid preflight prefix, not a bound execution. Its first
  record must be RunBinding. Referenced artifact internals remain opaque except
  canonical pending commands; verification does not invent bundle/adaptor schemas.

## Validation and next milestone

- `uv run mypy --strict`: clean on 74 source/test files.
- Latest `uv run pytest tests/vnext -q`: **167 passed, 4 xfailed**.
- Full `uv run pytest -q`: **464 passed, 4 xfailed, 2 failed**, 171.67 seconds.
  That run collected before the final two regression tests, both included in
  the latest focused vNext result above.
- The only full-suite failures are the unchanged
  `test_packaging.py::test_wheel_ships_package_data` and
  `test_packaging.py::test_installed_console_script_runs_in_isolated_env`.
  Their `uv build` child exits 101 inside macOS `system-configuration-0.6.1`
  with `Attempted to create a NULL object`, before building project code.
  Offline mode and disabling build isolation reproduce it. Tests were not
  skipped, weakened, or converted to xfail. The full-suite green gate therefore
  remains blocked by this environment.
- A separate offline wheel build using the locally cached Hatchling backend
  succeeded. The wheel contains the new modules and existing policy data;
  importing that wheel and running its legacy sandbox CLI also succeeded.
- `git diff --check` is clean. Branch is `strive-astra`; no commits or PRs.

Test commands used `UV_OFFLINE=1 UV_NO_SYNC=1`, with `UV_CACHE_DIR`, `TMPDIR`,
and pytest `--basetemp` under strive. This avoids dependency resolution for
`uv run` and keeps generated files in the authorized tree. Production storage
and verification use only stdlib and frozen contracts. Temporary caches,
builds, and test artifacts were removed.

Milestone 3 should first build the serial supervisor and broker around these
append ports and epochs: commit accepted commands, establish defensible resource
bounds, reserve before dispatch, retain exact requests/returns, settle known
usage, and atomically consume results with continuations. Next enforce sandbox
isolation and scoped access so candidates cannot reach storage or signing keys.
Add operator recovery with explicit damaged-tail handling and adapter-supported
reconciliation; never infer nonexecution from process death. Fault injection
must span authorization, harness launch, upstream forwarding, return, settlement,
and continuation before qualifying external harnesses. Guarantees 1 through 4 remain
strict-xfail until their runtime boundaries exist.
