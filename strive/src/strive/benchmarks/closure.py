"""Retain source, artifacts and data; offline resume accepts only those bytes."""
from collections.abc import Mapping
from pathlib import Path

from ..codec import decode, encode
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..store.cas import CAS

REQUIRED = frozenset({"source", "wheel", "licenses", "dependencies", "lock", "runtime", "build",
                      "tasks", "splits", "databases", "policies", "schemas", "environment", "scorer", "user", "qualification"})


def retain_closure(objects: CAS, files: Mapping[str, tuple[Path, ...]]) -> ArtifactRef:
    if set(files) != REQUIRED or any(not paths for paths in files.values()):
        raise VerificationError("incomplete benchmark closure")
    entries = tuple((category, tuple((path.name, objects.publish(path.read_bytes())) for path in paths))
                    for category, paths in sorted(files.items()))
    return objects.publish(encode(("benchmark-closure/1", entries)))


def verify_closure(objects: CAS, reference: ArtifactRef) -> None:
    value = decode(objects.read(reference))
    if not isinstance(value, tuple) or len(value) != 2 or value[0] != "benchmark-closure/1" or not isinstance(value[1], tuple):
        raise VerificationError("invalid benchmark closure")
    categories: set[str] = set()
    for entry in value[1]:
        if not isinstance(entry, tuple) or len(entry) != 2 or not isinstance(entry[0], str) or not isinstance(entry[1], tuple) or not entry[1]:
            raise VerificationError("invalid closure entry")
        categories.add(entry[0])
        for artifact in entry[1]:
            if not isinstance(artifact, tuple) or len(artifact) != 2 or not isinstance(artifact[1], ArtifactRef):
                raise VerificationError("invalid closure artifact")
            objects.read(artifact[1])
    if categories != REQUIRED:
        raise VerificationError("incomplete benchmark closure")
