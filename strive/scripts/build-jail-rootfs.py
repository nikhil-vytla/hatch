"""Build a runtime-only root tree inside the image; never copy /home or site-packages."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
for directory in ("app", "scratch", "proc", "sys", "dev", "etc", "usr/local/bin", "usr/local/lib"):
    (root / directory).mkdir(parents=True, exist_ok=True)
for device in ("null", "zero", "random", "urandom"):
    (root / "dev" / device).touch()
(root / "tmp").symlink_to("scratch")
(root / "dev/fd").symlink_to("/proc/self/fd")
for name, fd in (("stdin", 0), ("stdout", 1), ("stderr", 2)):
    (root / "dev" / name).symlink_to(f"/proc/self/fd/{fd}")
shutil.copy2("/etc/ld.so.cache", root / "etc/ld.so.cache")
stdlib = Path("/usr/local/lib/python3.12")
shutil.copytree(stdlib, root / stdlib.relative_to("/"), dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests", "ensurepip", "idlelib", "tkinter"))


def copy_binary(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    # ldd is applied only to trusted image binaries, never candidate input.
    result = subprocess.run(["ldd", str(source)], capture_output=True, text=True)
    if result.returncode:
        if "not a dynamic executable" in result.stderr + result.stdout:
            return
        raise RuntimeError(result.stderr)
    for library in re.findall(r"(?:=>\s+)?(/[^\s()]+)", result.stdout):
        target = root / library.removeprefix("/")
        if not target.exists():
            copy_binary(Path(library), target)


copy_binary(Path(sys.executable).resolve(), root / "usr/local/bin/python3.12")
copy_binary(Path("/usr/local/bin/deno"), root / "usr/local/bin/deno")
opencode = shutil.which("opencode")
if opencode:
    copy_binary(Path(opencode), root / "usr/local/bin/opencode")
for extension in (root / "usr/local/lib/python3.12/lib-dynload").glob("*.so"):
    original = Path("/") / extension.relative_to(root)
    copy_binary(original, extension)
manifest = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file() and not path.is_symlink()}
(root.parent / "runtime-manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
