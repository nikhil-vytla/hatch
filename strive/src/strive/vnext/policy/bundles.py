"""Complete immutable bundles and trusted, durable compatibility checks."""
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
import sqlite3

from ..codec import decode, encode
from ..contracts.commands import ApplyChange, RestoreBundle
from ..contracts.lifecycle import EffectState
from ..contracts.feedback import FEEDBACK_ACCESS_MATRIX, EvidencePool
from ..contracts.primitives import AccessScope, ArtifactRef, ExecutionStatus
from ..errors import VerificationError
from ..store.cas import CAS, durable_directory, fsync_directory
from ..verify.engine import VerifiedState
from .data import Bundle, Dependency, FileVersion, Origin, Proposal, dumps, loads


def surface(path: str) -> str:
    parsed = PurePosixPath(path)
    if (not path or str(parsed) != path or parsed.is_absolute() or ".." in parsed.parts
            or "\\" in path or len(parsed.parts) < 2):
        raise VerificationError("invalid bundle path")
    prefixes = {"actor": "actor.code", "prompts": "actor.prompts", "memory": "actor.memory",
                "skills": "actor.memory", "controller": "controller.code"}
    if parsed.parts[0] not in prefixes:
        raise VerificationError("out-of-editable-scope path")
    return prefixes[parsed.parts[0]]


class BundleManager:
    """Only trusted composition owns this registry; candidate code sees bytes.

    Registry rows certify compatibility, never activation. RevisionActivation in
    the run journal remains the sole authority for which bundle is executing.
    """
    def __init__(self, root: Path, objects: CAS, scope: AccessScope, editable: tuple[str, ...],
                 dependencies: tuple[Dependency, ...] = (), capabilities: tuple[str, ...] = ()) -> None:
        self.objects, self.scope, self.editable = objects, scope, frozenset(editable)
        self.dependencies, self.capabilities = dependencies, frozenset(capabilities)
        self.state: Callable[[], VerifiedState] | None = None
        self._allowed_pools: frozenset[str] | None = None
        durable_directory(root)
        self.db = sqlite3.connect(root / "bundles.sqlite")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS config (value BLOB PRIMARY KEY)")
        config = encode((scope, editable, tuple((d.name, d.source) for d in dependencies), capabilities))
        prior = self.db.execute("SELECT value FROM config").fetchall()
        if prior and prior != [(config,)]:
            self.db.close()
            raise VerificationError("bundle compatibility configuration changed")
        self.db.execute("INSERT OR IGNORE INTO config VALUES (?)", (config,))
        self.db.execute("CREATE TABLE IF NOT EXISTS bundles (reference TEXT PRIMARY KEY, parent TEXT, revision TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS approvals (reference TEXT PRIMARY KEY, command BLOB)")
        self.db.execute("CREATE TABLE IF NOT EXISTS files (reference TEXT PRIMARY KEY)")
        self.db.commit()
        fsync_directory(root)

    def _file(self, value: FileVersion) -> ArtifactRef:
        ref = self.objects.publish(dumps(value))
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO files VALUES (?)", (ref.digest,))
        return ref

    def file(self, ref: ArtifactRef) -> FileVersion:
        if self.db.execute("SELECT 1 FROM files WHERE reference=?", (ref.digest,)).fetchone() is None:
            raise VerificationError("file provenance has not been admitted")
        value = loads(self.objects.read(ref), FileVersion)
        if value.scope != self.scope or any(o.scope != self.scope or o.pool not in {"development", "validation", "operational_failures"}
                                           for o in value.origins):
            raise VerificationError("file/import access scope is not permitted")
        if self.state is not None and self._allowed_pools is None:
            binding = self.state().binding
            if binding is not None:
                feedback = binding.feedback_contract
                self._allowed_pools = frozenset(p.value for p in FEEDBACK_ACCESS_MATRIX[feedback.contract].adaptation
                    if p is not EvidencePool.OPERATIONAL_FAILURES or feedback.operational_failures_visible)
        if self._allowed_pools is not None and any(o.pool not in self._allowed_pools for o in value.origins):
            raise VerificationError("file provenance exceeds feedback contract")
        self.objects.read(value.content)
        for origin in value.origins:
            self.objects.read(origin.reference)
        return value

    def load(self, ref: ArtifactRef) -> Bundle:
        value = loads(self.objects.read(ref), Bundle)
        self.validate(value)
        return value

    def validate(self, value: Bundle) -> None:
        paths = [p for p, _ in value.files]
        if (value.interface != "step/1" or len(paths) != len(set(paths))
                or not {"actor/step.js", "controller/step.js"} <= set(paths)):
            raise VerificationError("invalid bundle structure or step interface")
        for path, ref in value.files:
            surface(path)
            version = self.file(ref)
            if path.endswith(".js"):
                self.objects.read(version.content).decode("utf-8")
        if len({d.name for d in value.dependencies}) != len(value.dependencies):
            raise VerificationError("duplicate dependency")
        for dependency in value.dependencies:
            if dependency not in self.dependencies:
                raise VerificationError("missing-dependency: dependency is not in pinned environment")
            self.objects.read(dependency.source).decode("utf-8")
        if not set(value.capabilities) <= self.capabilities:
            raise VerificationError("requested capabilities exceed supplied grants")

    def initial(self, files: Mapping[str, bytes], source: ArtifactRef) -> ArtifactRef:
        self.objects.read(source)
        versions = tuple((path, self._file(FileVersion(self.objects.publish(data), self.scope,
            (Origin(source, self.scope, "development"),)))) for path, data in sorted(files.items()))
        bundle = Bundle(versions)
        self.validate(bundle)
        ref = self.objects.publish(dumps(bundle))
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO bundles VALUES (?,NULL,NULL)", (ref.digest,))
        return ref

    def compatible(self, ref: ArtifactRef) -> bool:
        self.load(ref)
        row = self.db.execute("SELECT parent,revision FROM bundles WHERE reference=?", (ref.digest,)).fetchone()
        if row is None or self.state is None:
            return False
        state = self.state()
        if state.binding is None or frozenset(state.binding.editable_scope) != self.editable:
            return False
        if state.pending_command is not None and state.execution_status is not ExecutionStatus.SUSPENDED:
            command_bytes = self.objects.read(state.pending_command)
            command = decode(command_bytes)
            if not isinstance(command, (ApplyChange, RestoreBundle)):
                return False
            if state.active_bundle is not None:
                old_controller = {p: v for p, v in self.load(state.active_bundle).files if surface(p) == "controller.code"}
                new_controller = {p: v for p, v in self.load(ref).files if surface(p) == "controller.code"}
                if old_controller != new_controller and command.controller_state is None:
                    return False
            if ref not in {bundle for _, bundle in state.revisions}:
                approval = self.db.execute("SELECT command FROM approvals WHERE reference=?", (ref.digest,)).fetchone()
                if approval != (command_bytes,):
                    return False
        if ref in {bundle for _, bundle in state.revisions}:
            return True
        return (state.active_bundle is not None and row == (state.active_bundle.digest, state.active_revision))

    def build(self, proposal: Proposal, state: VerifiedState, origins: tuple[Origin, ...] = ()) -> ApplyChange:
        if (proposal.expected_revision != state.active_revision or state.active_bundle is None):
            raise VerificationError("wrong expected-revision")
        if (state.pending_command is not None or state.execution_status is not ExecutionStatus.CONTINUE
                or any(e.state is not EffectState.CONSUMED for e in state.effects)):
            raise VerificationError("activation requires a boundary with no pending command/unconsumed result")
        if proposal.decision != "revise" or proposal.restore is not None:
            raise VerificationError("revision proposal required")
        old = self.load(state.active_bundle)
        files = dict(old.files)
        if len({e.path for e in proposal.edits}) != len(proposal.edits):
            raise VerificationError("duplicate edit")
        controller = any(surface(e.path) == "controller.code" for e in proposal.edits)
        if controller != (proposal.controller_state is not None):
            raise VerificationError("controller edit requires explicit initial private state")
        # Every accessed context contributes to every derived file. A model
        # cannot omit a source or narrow a validation origin to development.
        if any(o.scope != self.scope or o.pool not in {"development", "validation", "operational_failures"} for o in origins):
            raise VerificationError("derived file would widen input scope")
        for edit in proposal.edits:
            if surface(edit.path) not in self.editable:
                raise VerificationError("out-of-editable-scope edit")
            previous = files.get(edit.path)
            retained = self.file(previous).origins if previous is not None else ()
            inherited = tuple(dict.fromkeys((*retained, *origins)))
            if edit.imported_version is not None:
                if edit.content is not None:
                    raise VerificationError("import and replacement bytes are mutually exclusive")
                imported = self.file(edit.imported_version)
                content = imported.content
                inherited = tuple(dict.fromkeys((*inherited, *imported.origins,
                    Origin(edit.imported_version, imported.scope, "development"))))
            elif edit.content is None:
                files.pop(edit.path, None)
                continue
            else:
                content = self.objects.publish(edit.content)
            files[edit.path] = self._file(FileVersion(content, self.scope, inherited, previous))
        dependencies = old.dependencies if proposal.dependencies is None else proposal.dependencies
        capabilities = old.capabilities if proposal.capabilities is None else proposal.capabilities
        if (dependencies != old.dependencies or capabilities != old.capabilities) and "actor.code" not in self.editable:
            raise VerificationError("out-of-editable-scope dependency/capability edit")
        bundle = Bundle(tuple(sorted(files.items())), dependencies, capabilities)
        self.validate(bundle)
        ref = self.objects.publish(dumps(bundle))
        initial_state = self.objects.publish(proposal.controller_state) if proposal.controller_state is not None else None
        command = ApplyChange(ref, proposal.expected_revision, initial_state)
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO bundles VALUES (?,?,?)",
                            (ref.digest, state.active_bundle.digest, state.active_revision))
            self.db.execute("INSERT OR REPLACE INTO approvals VALUES (?,?)", (ref.digest, encode(command)))
        return command

    def close(self) -> None:
        self.db.close()
