"""Retained read-only data tree. Resume never downloads or trusts ambient files."""
from pathlib import Path

from strive.codec import decode, encode
from strive.contracts.primitives import ArtifactRef
from strive.errors import VerificationError
from strive.store.cas import CAS, atomic_file, durable_directory


def retain_data(objects: CAS, source: Path, destination: Path) -> ArtifactRef:
    entries: list[tuple[str, ArtifactRef]] = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink() or path.name == ".env":
            raise VerificationError("data trees cannot contain symlinks or ambient .env files")
        if path.is_file():
            name = path.relative_to(source).as_posix()
            data = path.read_bytes()
            ref = objects.publish(data)
            target = destination / name
            durable_directory(target.parent)
            atomic_file(target, data)
            target.chmod(0o444)
            entries.append((name, ref))
    if not entries:
        raise VerificationError("empty retained data tree")
    return objects.publish(encode(("tau2-data-tree/1", tuple(entries))))


def verify_data(objects: CAS, index: ArtifactRef, root: Path) -> None:
    value = decode(objects.read(index))
    if not isinstance(value, tuple) or len(value) != 2 or value[0] != "tau2-data-tree/1" or not isinstance(value[1], tuple):
        raise VerificationError("invalid retained data index")
    names: set[str] = set()
    for entry in value[1]:
        if not isinstance(entry, tuple) or len(entry) != 2 or not isinstance(entry[0], str) or not isinstance(entry[1], ArtifactRef):
            raise VerificationError("invalid retained data entry")
        name, reference = entry
        path = root / name
        if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink() or path.name == ".env":
            raise VerificationError("unsafe retained data path")
        if path.read_bytes() != objects.read(reference):
            raise VerificationError("materialized task/policy/database bytes changed")
        names.add(name)
    if names != {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}:
        raise VerificationError("unretained data files present")
