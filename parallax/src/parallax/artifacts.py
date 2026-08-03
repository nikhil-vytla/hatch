from __future__ import annotations

import json
import os
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .canonical import canonical_bytes, content_id, sha256_digest, validate_content_id, validate_digest
from .gsm8k import admit_task
from .records import AdmissionError, NativeTask, validate_relative_path


class ArtifactError(ValueError):
    """Published bytes do not satisfy their committed artifact contract."""


class ArtifactPathError(ArtifactError):
    """A protected path changed or could not be opened without following links."""


class StagingStateError(ArtifactPathError):
    """A staging directory may remain because pathname removal is unsafe."""

    def __init__(self, staging_name: str, staging_state: str) -> None:
        super().__init__(
            f"staging directory {staging_name!r} was not pathname-removed; "
            f"state: {staging_state}"
        )
        self.staging_name = staging_name
        self.staging_state = staging_state
        self.cleanup_succeeded = False


class PublicationStateError(ArtifactError):
    """Publication renamed a destination but could not return an ordinary receipt."""

    def __init__(
        self,
        message: str,
        *,
        requested_path_visible: bool,
        artifact_state: str,
        orphan_state: str,
        cleanup_attempted: bool,
        cleanup_succeeded: bool,
    ) -> None:
        super().__init__(message)
        self.requested_path_visible = requested_path_visible
        self.destination_visible = requested_path_visible
        self.artifact_state = artifact_state
        self.orphan_state = orphan_state
        self.empty_orphan = orphan_state == "empty"
        self.complete_orphan = orphan_state == "complete"
        self.partial_orphan = orphan_state == "partial"
        self.cleanup_attempted = cleanup_attempted
        self.cleanup_succeeded = cleanup_succeeded
        self.durability_indeterminate = True


class PublicationDurabilityError(ArtifactError):
    """A complete destination is visible but parent-directory durability is unknown."""

    def __init__(self, receipt: PublicationReceipt, snapshot: TreeSnapshot) -> None:
        super().__init__(
            "publication is visible and complete, but parent-directory fsync failed; "
            "durability after a crash is indeterminate"
        )
        self.destination_visible = True
        self.durability_indeterminate = True
        self.receipt = receipt
        self.snapshot = snapshot


@dataclass(frozen=True)
class TreePolicy:
    allowed_paths: tuple[str, ...]
    ignored_paths: tuple[str, ...] = ()
    reject_unexpected: bool = True
    schema: str = "parallax.tree-policy.v3"

    def __post_init__(self) -> None:
        for path in self.allowed_paths + self.ignored_paths:
            validate_relative_path(path)
        if self.allowed_paths != tuple(sorted(set(self.allowed_paths))):
            raise ValueError("allowed paths must be unique and sorted")
        if self.ignored_paths != tuple(sorted(set(self.ignored_paths))):
            raise ValueError("ignored paths must be unique and sorted")
        if set(self.allowed_paths) & set(self.ignored_paths):
            raise ValueError("a path cannot be both allowed and ignored")

    @property
    def id(self) -> str:
        return content_id("tree-policy", self)


@dataclass(frozen=True)
class TreeEntry:
    path: str
    byte_length: int
    digest: str

    def __post_init__(self) -> None:
        validate_relative_path(self.path)
        if self.byte_length < 0:
            raise ValueError("byte_length cannot be negative")
        validate_digest(self.digest)


@dataclass(frozen=True)
class TreeSnapshot:
    policy_id: str
    entries: tuple[TreeEntry, ...]
    schema: str = "parallax.tree-snapshot.v1"

    def __post_init__(self) -> None:
        validate_content_id(self.policy_id, "tree-policy")
        paths = tuple(entry.path for entry in self.entries)
        if paths != tuple(sorted(set(paths))):
            raise ValueError("tree entries must be unique and sorted")

    @property
    def id(self) -> str:
        return content_id("tree-snapshot", self)


@dataclass(frozen=True)
class PublicationReceipt:
    public_task_id: str
    artifact_manifest_id: str
    tree_snapshot_id: str
    tree_policy_id: str
    schema: str = "parallax.publication-receipt.v1"

    def __post_init__(self) -> None:
        validate_content_id(self.public_task_id, "public-task")
        validate_content_id(self.artifact_manifest_id, "artifact-manifest")
        validate_content_id(self.tree_snapshot_id, "tree-snapshot")
        validate_content_id(self.tree_policy_id, "tree-policy")

    @property
    def id(self) -> str:
        return content_id("publication-receipt", self)


@dataclass(frozen=True)
class ReplayLock:
    publication_receipt: PublicationReceipt
    tree_snapshot: TreeSnapshot
    verifier_commitment_id: str
    asset_manifest_id: str
    schema: str = "parallax.replay-lock.v3"

    def __post_init__(self) -> None:
        validate_content_id(self.verifier_commitment_id, "verifier-commitment")
        validate_content_id(self.asset_manifest_id, "asset-manifest")
        if self.publication_receipt.tree_snapshot_id != self.tree_snapshot.id:
            raise ValueError("replay lock receipt and snapshot disagree")
        if self.publication_receipt.tree_policy_id != self.tree_snapshot.policy_id:
            raise ValueError("replay lock receipt and snapshot policies disagree")

    @property
    def id(self) -> str:
        return content_id("replay-lock", self)


@dataclass(frozen=True)
class _TreeCapture:
    snapshot: TreeSnapshot
    files: tuple[tuple[str, bytes], ...]

    def as_dict(self) -> dict[str, bytes]:
        return dict(self.files)


@dataclass
class _DirectoryPath:
    lexical: Path
    descriptors: tuple[int, ...]
    identities: tuple[tuple[int, int], ...]

    @property
    def target_fd(self) -> int:
        return self.descriptors[-1]

    def close(self) -> None:
        for descriptor in reversed(self.descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


@dataclass(frozen=True)
class _CleanupOutcome:
    contents_state: str
    modified: bool


PUBLIC_TREE_POLICY = TreePolicy(("publication-manifest.json", "task.json"))


def _descriptor_flags(*, directory: bool = False) -> int:
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ArtifactError("artifact operations require POSIX no-follow directory descriptors")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if directory:
        flags |= os.O_DIRECTORY
    return flags


def _directory_identity(descriptor: int) -> tuple[int, int]:
    try:
        metadata = os.fstat(descriptor)
    except OSError as error:
        raise ArtifactPathError("could not inspect protected directory descriptor") from error
    return metadata.st_dev, metadata.st_ino


def _open_directory_path(path: Path) -> _DirectoryPath:
    lexical = path if path.is_absolute() else Path.cwd() / path
    if any(part in (".", "..") for part in lexical.parts):
        raise ArtifactError("directory path must not contain dot or parent components")
    descriptors: list[int] = []
    identities: list[tuple[int, int]] = []
    try:
        descriptor = os.open(os.path.sep, _descriptor_flags(directory=True))
    except OSError as error:
        raise ArtifactPathError("could not open filesystem root") from error
    descriptors.append(descriptor)
    try:
        identities.append(_directory_identity(descriptor))
        for part in lexical.parts[1:]:
            try:
                next_descriptor = os.open(
                    part,
                    _descriptor_flags(directory=True),
                    dir_fd=descriptor,
                )
            except OSError as error:
                raise ArtifactPathError(
                    f"protected directory traversal failed at component: {part}"
                ) from error
            descriptor = next_descriptor
            descriptors.append(descriptor)
            identities.append(_directory_identity(descriptor))
        return _DirectoryPath(lexical, tuple(descriptors), tuple(identities))
    except Exception:
        for opened in reversed(descriptors):
            try:
                os.close(opened)
            except OSError:
                pass
        raise


def _assert_path_identity(path: Path, identities: tuple[tuple[int, int], ...]) -> None:
    reopened = _open_directory_path(path)
    try:
        if reopened.identities != identities:
            raise ArtifactPathError("requested lexical directory ancestry changed")
    finally:
        reopened.close()


def _path_identity_matches(path: Path, identities: tuple[tuple[int, int], ...]) -> bool:
    try:
        _assert_path_identity(path, identities)
    except ArtifactError:
        return False
    return True


def _is_ignored(relative: str, policy: TreePolicy) -> bool:
    return any(relative == ignored or relative.startswith(ignored + "/") for ignored in policy.ignored_paths)


def _directory_changed(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_mtime_ns,
        before.st_ctime_ns,
    ) != (
        after.st_dev,
        after.st_ino,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )


def _read_once(directory_fd: int, name: str, relative: str) -> bytes:
    try:
        file_fd = os.open(name, _descriptor_flags(), dir_fd=directory_fd)
    except OSError as error:
        raise ArtifactPathError(
            f"protected file open failed during capture: {relative}"
        ) from error
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode):
            raise ArtifactError(f"non-regular tree entry: {relative}")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(file_fd)
        data = b"".join(chunks)
        stable = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) == (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if not stable or len(data) != after.st_size:
            raise ArtifactError(f"file changed during capture: {relative}")
        return data
    finally:
        os.close(file_fd)


def _capture_tree_fd(root_fd: int, policy: TreePolicy) -> _TreeCapture:
    discovered: dict[str, bytes] = {}

    def visit(directory_fd: int, prefix: str = "") -> None:
        before_directory = os.fstat(directory_fd)
        try:
            with os.scandir(directory_fd) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError as error:
            raise ArtifactPathError(
                f"protected directory scan failed: {prefix or '.'}"
            ) from error
        for item in entries:
            relative = f"{prefix}/{item.name}" if prefix else item.name
            validate_relative_path(relative)
            try:
                item_stat = item.stat(follow_symlinks=False)
            except OSError as error:
                raise ArtifactPathError(
                    f"tree entry changed before inspection: {relative}"
                ) from error
            if stat.S_ISLNK(item_stat.st_mode):
                raise ArtifactError(f"symlink is forbidden: {relative}")
            if _is_ignored(relative, policy):
                continue
            if stat.S_ISDIR(item_stat.st_mode):
                contains_allowed = any(
                    allowed.startswith(relative + "/") for allowed in policy.allowed_paths
                )
                if policy.reject_unexpected and not contains_allowed:
                    raise ArtifactError(f"unexpected directory: {relative}")
                try:
                    child_fd = os.open(
                        item.name,
                        _descriptor_flags(directory=True),
                        dir_fd=directory_fd,
                    )
                except OSError as error:
                    raise ArtifactPathError(
                        f"protected directory open failed during capture: {relative}"
                    ) from error
                try:
                    visit(child_fd, relative)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(item_stat.st_mode):
                if policy.reject_unexpected and relative not in policy.allowed_paths:
                    raise ArtifactError(f"unexpected file: {relative}")
                discovered[relative] = _read_once(directory_fd, item.name, relative)
            else:
                raise ArtifactError(f"non-regular tree entry: {relative}")
        if _directory_changed(before_directory, os.fstat(directory_fd)):
            raise ArtifactError(f"directory changed during capture: {prefix or '.'}")

    visit(root_fd)
    missing = set(policy.allowed_paths) - set(discovered)
    if missing:
        raise ArtifactError(f"missing allowed files: {', '.join(sorted(missing))}")
    files = tuple((path, discovered[path]) for path in sorted(discovered))
    entries = tuple(TreeEntry(path, len(data), sha256_digest(data)) for path, data in files)
    return _TreeCapture(TreeSnapshot(policy.id, entries), files)


def _capture_tree(root: Path, policy: TreePolicy) -> _TreeCapture:
    opened = _open_directory_path(root)
    try:
        capture = _capture_tree_fd(opened.target_fd, policy)
        _assert_path_identity(opened.lexical, opened.identities)
        return capture
    finally:
        opened.close()


def snapshot_tree(root: Path, policy: TreePolicy) -> TreeSnapshot:
    return _capture_tree(root, policy).snapshot


def _artifact_manifest(task_bytes: bytes) -> dict[str, object]:
    entries = [{"path": "task.json", "byte_length": len(task_bytes), "digest": sha256_digest(task_bytes)}]
    body: dict[str, object] = {"schema": "parallax.artifact-manifest.v1", "entries": entries}
    return {**body, "id": content_id("artifact-manifest", body)}


def _verify_public_capture(capture: _TreeCapture, task: NativeTask) -> str:
    files = capture.as_dict()
    task_bytes = files.get("task.json")
    manifest_bytes = files.get("publication-manifest.json")
    if task_bytes is None or manifest_bytes is None:
        raise ArtifactError("public artifact files are missing")
    expected_task = canonical_bytes(task.public.as_record())
    if task_bytes != expected_task:
        raise ArtifactError("public task bytes do not match the committed public identity")
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactError("publication manifest is not valid UTF-8 JSON") from error
    if canonical_bytes(manifest) != manifest_bytes:
        raise ArtifactError("publication manifest is not canonical")
    expected_manifest = _artifact_manifest(task_bytes)
    if manifest != expected_manifest:
        raise ArtifactError("publication manifest commitment mismatch")
    return str(expected_manifest["id"])


def verify_publication(root: Path, task: NativeTask) -> str:
    opened = _open_directory_path(root)
    try:
        capture = _capture_tree_fd(opened.target_fd, PUBLIC_TREE_POLICY)
        manifest_id = _verify_public_capture(capture, task)
        _assert_path_identity(opened.lexical, opened.identities)
        return manifest_id
    finally:
        opened.close()


def _write_durable(directory_fd: int, name: str, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    try:
        file_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
    except OSError as error:
        raise ArtifactPathError(f"protected artifact creation failed: {name}") from error
    try:
        view = memoryview(data)
        while view:
            written = os.write(file_fd, view)
            if written <= 0:
                raise OSError("artifact write made no progress")
            view = view[written:]
        os.fsync(file_fd)
    finally:
        os.close(file_fd)


def _make_staging(parent_fd: int) -> tuple[str, int]:
    for _ in range(100):
        name = f".parallax-staging-{secrets.token_hex(12)}"
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            continue
        except OSError as error:
            raise ArtifactPathError("staging directory creation failed") from error
        try:
            descriptor = os.open(
                name,
                _descriptor_flags(directory=True),
                dir_fd=parent_fd,
            )
        except OSError as error:
            raise StagingStateError(name, "indeterminate") from error
        return name, descriptor
    raise ArtifactError("could not allocate a unique staging directory")


def _cleanup_directory_contents(directory_fd: int) -> _CleanupOutcome:
    modified = False
    failed = False
    for name in PUBLIC_TREE_POLICY.allowed_paths:
        try:
            os.unlink(name, dir_fd=directory_fd)
            modified = True
        except FileNotFoundError:
            pass
        except OSError:
            failed = True
    try:
        with os.scandir(directory_fd) as iterator:
            remaining = tuple(iterator)
    except OSError:
        return _CleanupOutcome("indeterminate", modified)
    if not remaining:
        return _CleanupOutcome("empty", modified)
    if modified:
        return _CleanupOutcome("partial", True)
    if failed:
        return _CleanupOutcome("unchanged", False)
    return _CleanupOutcome("indeterminate", False)


def _cleanup_staging(staging_fd: int) -> _CleanupOutcome:
    try:
        return _cleanup_directory_contents(staging_fd)
    finally:
        try:
            os.close(staging_fd)
        except OSError:
            pass


def _cleanup_published(destination_fd: int) -> _CleanupOutcome:
    try:
        return _cleanup_directory_contents(destination_fd)
    except OSError:
        return _CleanupOutcome("indeterminate", False)


def publish_public_task(destination: Path, task: NativeTask) -> tuple[PublicationReceipt, TreeSnapshot]:
    destination = destination.absolute()
    validate_relative_path(destination.name)
    parent = _open_directory_path(destination.parent)
    staging_name = ""
    staging_fd = -1
    destination_fd = -1
    destination_identities: tuple[tuple[int, int], ...] = ()
    renamed = False
    artifact_complete = False
    try:
        try:
            os.stat(destination.name, dir_fd=parent.target_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ArtifactError("publication destination already exists")
        staging_name, staging_fd = _make_staging(parent.target_fd)
        task_bytes = canonical_bytes(task.public.as_record())
        manifest_bytes = canonical_bytes(_artifact_manifest(task_bytes))
        _write_durable(staging_fd, "task.json", task_bytes)
        _write_durable(staging_fd, "publication-manifest.json", manifest_bytes)
        _verify_public_capture(_capture_tree_fd(staging_fd, PUBLIC_TREE_POLICY), task)
        _assert_path_identity(parent.lexical, parent.identities)
        try:
            os.replace(
                staging_name,
                destination.name,
                src_dir_fd=parent.target_fd,
                dst_dir_fd=parent.target_fd,
            )
        except OSError as error:
            raise ArtifactPathError("atomic publication rename failed") from error
        renamed = True
        destination_fd = staging_fd
        staging_fd = -1
        destination_identities = parent.identities + (
            _directory_identity(destination_fd),
        )
        final_capture = _capture_tree_fd(destination_fd, PUBLIC_TREE_POLICY)
        manifest_id = _verify_public_capture(final_capture, task)
        artifact_complete = True
        _assert_path_identity(destination, destination_identities)
        snapshot = final_capture.snapshot
        receipt = PublicationReceipt(
            task.public.id,
            manifest_id,
            snapshot.id,
            PUBLIC_TREE_POLICY.id,
        )
        durability_error: OSError | None = None
        try:
            os.fsync(parent.target_fd)
        except OSError as error:
            durability_error = error
        _assert_path_identity(destination, destination_identities)
        if durability_error is not None:
            raise PublicationDurabilityError(receipt, snapshot) from durability_error
        return receipt, snapshot
    except PublicationDurabilityError:
        raise
    except Exception as error:
        if renamed:
            visible = bool(destination_identities) and _path_identity_matches(
                destination, destination_identities
            )
            cleanup_attempted = destination_fd >= 0
            cleanup = (
                _cleanup_published(destination_fd)
                if cleanup_attempted
                else _CleanupOutcome("indeterminate", False)
            )
            cleanup_succeeded = False
            visible = bool(destination_identities) and _path_identity_matches(
                destination, destination_identities
            )
            if cleanup.contents_state == "empty":
                artifact_state = "empty-orphan"
            elif cleanup.contents_state == "partial":
                artifact_state = "partial"
            elif cleanup.contents_state == "unchanged" and artifact_complete:
                artifact_state = "complete"
            else:
                artifact_state = "indeterminate"
            if visible:
                orphan_state = "none"
            elif artifact_state == "empty-orphan":
                orphan_state = "empty"
            else:
                orphan_state = artifact_state
            raise PublicationStateError(
                f"publication was renamed but could not be accepted: {type(error).__name__}",
                requested_path_visible=visible,
                artifact_state=artifact_state,
                orphan_state=orphan_state,
                cleanup_attempted=cleanup_attempted,
                cleanup_succeeded=cleanup_succeeded,
            ) from error
        if staging_fd >= 0:
            cleanup = _cleanup_staging(staging_fd)
            staging_fd = -1
            raise StagingStateError(
                staging_name,
                f"{cleanup.contents_state}-orphan",
            ) from error
        raise
    finally:
        if destination_fd >= 0:
            try:
                os.close(destination_fd)
            except OSError:
                pass
        try:
            if staging_fd >= 0:
                _cleanup_staging(staging_fd)
        finally:
            parent.close()


def make_replay_lock(
    receipt: PublicationReceipt,
    snapshot: TreeSnapshot,
    task: NativeTask,
    policy: TreePolicy,
) -> ReplayLock:
    if receipt.tree_policy_id != policy.id or snapshot.policy_id != policy.id:
        raise ValueError("receipt, snapshot, and replay policy must match")
    return ReplayLock(receipt, snapshot, task.verifier.id, task.assets.id)


def replay_locked(
    root: Path,
    lock: ReplayLock,
    task: NativeTask,
    available_assets: Mapping[str, bytes],
    policy: TreePolicy,
) -> dict[str, bytes]:
    try:
        admit_task(task, available_assets)
    except AdmissionError:
        raise
    except Exception as error:
        raise AdmissionError("replay admission failed") from error
    if task.verifier.id != lock.verifier_commitment_id or task.assets.id != lock.asset_manifest_id:
        raise AdmissionError("replay verifier or asset commitment changed")
    if task.public.id != lock.publication_receipt.public_task_id:
        raise AdmissionError("replay public identity changed")
    if (
        lock.publication_receipt.tree_policy_id != lock.tree_snapshot.policy_id
        or lock.tree_snapshot.policy_id != policy.id
    ):
        raise ArtifactError("receipt, snapshot, and actual replay policies disagree")
    opened = _open_directory_path(root)
    try:
        capture = _capture_tree_fd(opened.target_fd, policy)
        if capture.snapshot != lock.tree_snapshot:
            raise ArtifactError("published tree differs from replay lock")
        manifest_id = _verify_public_capture(capture, task)
        if manifest_id != lock.publication_receipt.artifact_manifest_id:
            raise ArtifactError("artifact manifest differs from publication receipt")
        _assert_path_identity(opened.lexical, opened.identities)
        return capture.as_dict()
    finally:
        opened.close()
