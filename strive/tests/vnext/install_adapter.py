"""Build a minimal wheel of our own adapter sources for offline install probes.

No upstream dependency is bundled or installed. The worker stays unavailable
until the independently pinned telecom environment can be resolved.
"""
import base64
import csv
import hashlib
import io
import os
from pathlib import Path
import subprocess
import zipfile


def install_light_adapter(project: Path, target: Path, workspace: Path) -> None:
    distribution = "strive_benchmark_tau2"
    dist_info = distribution + "-0.1.0.dist-info"
    entries: dict[str, bytes] = {}
    for path in sorted((project / "src").rglob("*.py")):
        entries[path.relative_to(project / "src").as_posix()] = path.read_bytes()
    entries[dist_info + "/METADATA"] = b"Metadata-Version: 2.1\nName: strive-benchmark-tau2\nVersion: 0.1.0\nRequires-Python: >=3.12\n"
    entries[dist_info + "/WHEEL"] = b"Wheel-Version: 1.0\nGenerator: strive-offline-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for name, data in entries.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + digest, len(data)))
    writer.writerow((dist_info + "/RECORD", "", ""))
    entries[dist_info + "/RECORD"] = record.getvalue().encode()
    wheel = workspace / (distribution + "-0.1.0-py3-none-any.whl")
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    # This fixture wheel is purelib-only: installing it consists of placing its
    # verified entries and dist-info under the isolated site-packages directory.
    # No build backend, resolver, dependency install, script or .pth is involved.
    target.mkdir()
    with zipfile.ZipFile(wheel) as archive:
        for name, expected in entries.items():
            data = archive.read(name)
            assert data == expected and not Path(name).is_absolute() and ".." not in Path(name).parts
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
