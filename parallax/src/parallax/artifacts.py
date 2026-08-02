from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .canonical import canonical_bytes, content_id, sha256_digest, validate_content_id, validate_digest
from .gsm8k import admit_task
from .records import AdmissionError, NativeTask, validate_relative_path


class ArtifactError(ValueError):
    """Published bytes do not satisfy their committed artifact contract."""


@dataclass(frozen=True)
class TreePolicy:
    allowed_paths: tuple[str, ...]
    ignored_paths: tuple[str, ...] = ()
    reject_unexpected: bool = True
    schema: str = "parallax.tree-policy.v1"

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
    schema: str = "parallax.replay-lock.v1"

    def __post_init__(self) -> None:
        validate_content_id(self.verifier_commitment_id, "verifier-commitment")
        validate_content_id(self.asset_manifest_id, "asset-manifest")
        if self.publication_receipt.tree_snapshot_id != self.tree_snapshot.id:
            raise ValueError("replay lock receipt and snapshot disagree")

    @property
    def id(self) -> str:
        return content_id("replay-lock", self)


PUBLIC_TREE_POLICY = TreePolicy(("publication-manifest.json", "task.json"))


def _is_ignored(relative: str, policy: TreePolicy) -> bool:
    return any(relative == ignored or relative.startswith(ignored + "/") for ignored in policy.ignored_paths)


def snapshot_tree(root: Path, policy: TreePolicy) -> TreeSnapshot:
    if root.is_symlink():
        raise ArtifactError("snapshot root cannot be a symlink")
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ArtifactError("snapshot root must be a directory")
    discovered: dict[str, TreeEntry] = {}

    def visit(directory: Path, prefix: str = "") -> None:
        for item in sorted(os.scandir(directory), key=lambda entry: entry.name):
            relative = f"{prefix}/{item.name}" if prefix else item.name
            validate_relative_path(relative)
            mode = item.stat(follow_symlinks=False).st_mode
            if stat.S_ISLNK(mode):
                raise ArtifactError(f"symlink is forbidden: {relative}")
            if _is_ignored(relative, policy):
                continue
            if stat.S_ISDIR(mode):
                contains_allowed = any(
                    allowed.startswith(relative + "/")
                    for allowed in policy.allowed_paths
                )
                if policy.reject_unexpected and not contains_allowed:
                    raise ArtifactError(f"unexpected directory: {relative}")
                visit(Path(item.path), relative)
            elif stat.S_ISREG(mode):
                if policy.reject_unexpected and relative not in policy.allowed_paths:
                    raise ArtifactError(f"unexpected file: {relative}")
                data = Path(item.path).read_bytes()
                discovered[relative] = TreeEntry(relative, len(data), sha256_digest(data))
            else:
                raise ArtifactError(f"non-regular tree entry: {relative}")

    visit(root)
    missing = set(policy.allowed_paths) - set(discovered)
    if missing:
        raise ArtifactError(f"missing allowed files: {', '.join(sorted(missing))}")
    return TreeSnapshot(policy.id, tuple(discovered[path] for path in sorted(discovered)))


def _artifact_manifest(task_bytes: bytes) -> dict[str, object]:
    entries = [{"path": "task.json", "byte_length": len(task_bytes), "digest": sha256_digest(task_bytes)}]
    body: dict[str, object] = {"schema": "parallax.artifact-manifest.v1", "entries": entries}
    return {**body, "id": content_id("artifact-manifest", body)}


def _write_durable(path: Path, data: bytes) -> None:
    with path.open("xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def verify_publication(root: Path, task: NativeTask) -> str:
    snapshot_tree(root, PUBLIC_TREE_POLICY)
    task_bytes = (root / "task.json").read_bytes()
    expected_task = canonical_bytes(task.public.as_record())
    if task_bytes != expected_task:
        raise ArtifactError("public task bytes do not match the committed public identity")
    manifest_bytes = (root / "publication-manifest.json").read_bytes()
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


def publish_public_task(destination: Path, task: NativeTask) -> tuple[PublicationReceipt, TreeSnapshot]:
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ArtifactError("publication destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".parallax-staging-", dir=destination.parent))
    try:
        task_bytes = canonical_bytes(task.public.as_record())
        manifest_bytes = canonical_bytes(_artifact_manifest(task_bytes))
        _write_durable(staging / "task.json", task_bytes)
        _write_durable(staging / "publication-manifest.json", manifest_bytes)
        manifest_id = verify_publication(staging, task)
        snapshot = snapshot_tree(staging, PUBLIC_TREE_POLICY)
        os.replace(staging, destination)
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        receipt = PublicationReceipt(task.public.id, manifest_id, snapshot.id, PUBLIC_TREE_POLICY.id)
        return receipt, snapshot
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def make_replay_lock(receipt: PublicationReceipt, snapshot: TreeSnapshot, task: NativeTask) -> ReplayLock:
    return ReplayLock(receipt, snapshot, task.verifier.id, task.assets.id)


def replay_locked(
    root: Path,
    lock: ReplayLock,
    task: NativeTask,
    available_assets: Mapping[str, bytes],
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
    snapshot = snapshot_tree(root, PUBLIC_TREE_POLICY)
    if snapshot != lock.tree_snapshot:
        raise ArtifactError("published tree differs from replay lock")
    manifest_id = verify_publication(root, task)
    if manifest_id != lock.publication_receipt.artifact_manifest_id:
        raise ArtifactError("artifact manifest differs from publication receipt")
    return {path: (root / path).read_bytes() for path in PUBLIC_TREE_POLICY.allowed_paths}
