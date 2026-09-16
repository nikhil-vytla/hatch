"""Linux process-tree jail. No platform-name shortcut and no launch fallback.

Only the trusted supervisor can create cgroups. Payloads see an immutable,
minimal runtime tree, explicitly supplied files and quota-limited scratch.
The harness's effect-scoped stdin/stdout RPC is the sole gateway transport;
no IP route, host socket, provider credential or host directory is mounted.
"""
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from typing import BinaryIO, Mapping
import uuid

from ..codec import content_ref, encode

POLICY = Path(__file__).with_name("linux")
ENFORCED = ("cgroup-v2-memory-max", "cgroup-v2-pids-max", "private-network-namespace",
            "gateway-only-inherited-pipe", "seccomp-default-deny", "read-only-rootfs",
            "bounded-tmpfs-scratch", "no-new-privileges", "single-user-namespace-map",
            "private-pid-namespace", "cgroup-kill-process-tree")
DEFAULT_MEMORY = 256 * 1024 * 1024
DEFAULT_PIDS = 64
DEFAULT_SCRATCH = 16 * 1024 * 1024


class JailUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Capability:
    available: bool
    reason: str
    identity: bytes = b""


def settings() -> tuple[Path, Path]:
    return (Path(os.environ.get("STRIVE_JAIL_HOME", "/opt/strive-jail")),
            Path(os.environ.get("STRIVE_CGROUP_ROOT", "/sys/fs/cgroup/strive-jobs")))


def capability() -> Capability:
    home, groups = settings()
    return _detect(sys.platform, str(home), str(groups))


def require_capability() -> Capability:
    result = capability()
    if not result.available:
        raise JailUnavailable(result.reason)
    return result


@lru_cache(maxsize=8)
def _detect(platform: str, home_name: str, groups_name: str) -> Capability:
    if platform != "linux":
        return Capability(False, "Linux cgroups v2, user/mount/pid/net namespaces and seccomp unavailable on " + platform)
    try:
        jail = LinuxJail(Path(home_name), Path(groups_name))
        jail.verify_runtime()
        with jail:
            child = jail.popen([], {}, stdin=subprocess.DEVNULL)
            out, err = child.communicate(timeout=15)
            if child.returncode:
                raise JailUnavailable("jail probe failed: " + err.decode(errors="replace")[-2000:])
            evidence = json.loads(out)
            if evidence.get("status") != "enforced":
                raise JailUnavailable("missing kernel attestation")
        return Capability(True, "full jail applied and kernel state attested", jail.identity)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        return Capability(False, str(error))


class LinuxJail:
    def __init__(self, home: Path, groups: Path, *, memory_bytes: int = DEFAULT_MEMORY,
                 pids: int = DEFAULT_PIDS, scratch_bytes: int = DEFAULT_SCRATCH) -> None:
        if memory_bytes < 16 * 1024 * 1024 or pids < 8 or scratch_bytes < 4096:
            raise ValueError("jail limits below supported minimum")
        self.home, self.groups = home.resolve(), groups.resolve()
        self.memory_bytes, self.pids, self.scratch_bytes = memory_bytes, pids, scratch_bytes
        self.bwrap = shutil.which("bwrap")
        if sys.platform != "linux" or self.bwrap is None:
            raise JailUnavailable("Linux bubblewrap is not installed")
        if not {"memory", "pids"} <= set((self.groups / "cgroup.controllers").read_text().split()):
            raise JailUnavailable("delegated cgroups v2 memory/pids controllers unavailable")
        if not {"memory", "pids"} <= set((self.groups / "cgroup.subtree_control").read_text().split()):
            raise JailUnavailable("memory/pids not enabled in delegated cgroup subtree")
        self.identity: bytes = encode(("linux-jail/1", ENFORCED,
            tuple(content_ref(path.read_bytes()) for path in (Path(__file__), POLICY / "_enter_cgroup.py",
                POLICY / "_check.py", POLICY / "seccomp.allow", Path(self.bwrap),
                self.home / "seccomp.bpf", self.home / "runtime-manifest.json"))))
        self.group: Path = self.groups / ("job-" + uuid.uuid4().hex)
        self.process: subprocess.Popen[bytes] | None = None
        self.events: dict[str, int] = {}
        self._created: bool = False

    @classmethod
    def available(cls, *, memory_bytes: int = DEFAULT_MEMORY) -> "LinuxJail | None":
        detected = capability()
        if not detected.available:
            if os.environ.get("STRIVE_REQUIRE_JAIL") == "1":
                raise JailUnavailable(detected.reason)
            return None
        home, groups = settings()
        result = cls(home, groups, memory_bytes=memory_bytes)
        if result.identity != detected.identity:
            raise JailUnavailable("qualified jail implementation changed")
        return result

    def verify_runtime(self) -> None:
        manifest = json.loads((self.home / "runtime-manifest.json").read_bytes())
        if not isinstance(manifest, dict) or not manifest:
            raise JailUnavailable("runtime file manifest missing")
        root = self.home / "rootfs"
        actual = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file() and not path.is_symlink()}
        if actual != set(manifest):
            raise JailUnavailable("runtime tree differs from pinned file inventory")
        for name, digest in manifest.items():
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise JailUnavailable("unsafe runtime manifest path")
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise JailUnavailable("runtime bytes changed: " + name)

    def __enter__(self) -> "LinuxJail":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def popen(self, command: list[str], files: Mapping[str, Path], *,
              stdin: int | BinaryIO = subprocess.PIPE) -> subprocess.Popen[bytes]:
        if self._created:
            raise JailUnavailable("one process tree per jail")
        self.group.mkdir()
        self._created = True
        for name, value in (("memory.max", self.memory_bytes), ("memory.swap.max", 0),
                            ("memory.oom.group", 1), ("pids.max", self.pids)):
            path = self.group / name
            path.write_text(str(value))
            if path.read_text().strip() != str(value):
                raise JailUnavailable("kernel did not apply " + name)
        if not (self.group / "cgroup.kill").exists():
            raise JailUnavailable("cgroup.kill required for complete tree cleanup")
        expected = {"host_uid": os.getuid(), "host_gid": os.getgid(), "scratch_bytes": self.scratch_bytes,
                    "namespaces": {name: os.readlink("/proc/self/ns/" + name)
                                   for name in ("user", "mnt", "pid", "net", "ipc", "uts")}}
        assert self.bwrap is not None
        with (self.home / "seccomp.bpf").open("rb") as policy:
            args = [sys.executable, "-I", str(POLICY / "_enter_cgroup.py"), str(os.getpid()), str(self.group), self.bwrap,
                "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
                "--unshare-cgroup", "--uid", "65534", "--gid", "65534", "--cap-drop", "ALL",
                "--die-with-parent", "--new-session", "--hostname", "strive-jail",
                "--ro-bind", str(self.home / "rootfs"), "/", "--proc", "/proc",
                # Bind only inert device files. No /dev/shm or unbounded device tmpfs.
                "--dev-bind", "/dev/null", "/dev/null", "--dev-bind", "/dev/zero", "/dev/zero",
                "--dev-bind", "/dev/urandom", "/dev/urandom", "--dev-bind", "/dev/random", "/dev/random",
                "--size", str(self.scratch_bytes), "--perms", "1777", "--tmpfs", "/scratch",
                "--size", "1048576", "--tmpfs", "/app"]
            for name, path in files.items():
                if Path(name).name != name or not name:
                    raise ValueError("payload files require a basename")
                args.extend(("--ro-bind", str(path.resolve()), "/app/" + name))
            args.extend(("--ro-bind", str(POLICY / "_check.py"), "/app/check.py", "--remount-ro", "/app",
                "--chdir", "/scratch", "--clearenv", "--setenv", "PATH", "/usr/local/bin",
                "--setenv", "HOME", "/nonexistent", "--setenv", "TMPDIR", "/scratch",
                "--setenv", "DENO_DIR", "/scratch/cache", "--setenv", "DENO_NO_UPDATE_CHECK", "1",
                "--setenv", "NO_COLOR", "1", "--setenv", "LANG", "C", "--seccomp", str(policy.fileno()),
                "/usr/local/bin/python3.12", "-I", "-B", "/app/check.py", json.dumps(expected), *command))
            self.process = subprocess.Popen(args, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                close_fds=True, pass_fds=(policy.fileno(),), start_new_session=True,
                env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C"})
        return self.process

    def launch(self, command: list[str], *, stdin: int | BinaryIO = subprocess.PIPE) -> subprocess.Popen[bytes]:
        """Translate only explicit executable/script arguments into the minimal jail."""
        files: dict[str, Path] = {}
        translated: list[str] = []
        deno = shutil.which("deno")
        for value in command:
            path = Path(value)
            if value == sys.executable:
                translated.append("/usr/local/bin/python3.12")
            elif deno and path == Path(deno).resolve():
                if content_ref(path.read_bytes()) != content_ref((self.home / "rootfs/usr/local/bin/deno").read_bytes()):
                    raise JailUnavailable("jail Deno differs from the retained executable")
                translated.append("/usr/local/bin/deno")
            elif path.is_absolute() and path.is_file():
                name = f"input{len(files)}{path.suffix}"
                files[name] = path
                translated.append("/app/" + name)
            else:
                translated.append(value)
        return self.popen(translated, files, stdin=stdin)

    def read_events(self) -> dict[str, int]:
        if self._created:
            for source in ("memory.events", "pids.events"):
                for line in (self.group / source).read_text().splitlines():
                    name, value = line.split()
                    self.events[source + "." + name] = int(value)
            peak = self.group / "memory.peak"
            if peak.exists():
                self.events["memory.peak"] = int(peak.read_text())
        return dict(self.events)

    def kill(self) -> None:
        # Popen returns before _enter_cgroup.py necessarily attaches. Killing
        # the cgroup alone can miss that launcher and let it enter after cleanup.
        # Keep cgroup.kill for descendants that have created their own sessions.
        # A reaped launcher no longer owns its PID. The shim cannot fork before
        # attachment, so any surviving descendants then belong to the cgroup.
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self._created and self.group.exists():
            (self.group / "cgroup.kill").write_text("1")

    def close(self) -> None:
        self.kill()
        if self.process is not None:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise JailUnavailable("jail launcher did not exit after tree termination") from error
            self.process = None
        if not self._created or not self.group.exists():
            self._created = False
            return
        deadline = time.monotonic() + 5
        while "populated 1" in (self.group / "cgroup.events").read_text():
            if time.monotonic() >= deadline:
                raise JailUnavailable("cgroup remained populated after cgroup.kill")
            time.sleep(0.01)
        self.read_events()
        self.group.rmdir()
        self._created = False


def terminate_recorded_group(group_name: str, boot_id: str) -> None:
    """Kernel-atomic tree cancellation; never substitute a recycled process ID."""
    if sys.platform != "linux":
        raise JailUnavailable("Linux jail recovery requires Linux")
    if Path("/proc/sys/kernel/random/boot_id").read_text().strip() != boot_id:
        return  # The whole original process tree disappeared at reboot.
    _, groups = settings()
    group = Path(group_name)
    if group.parent != groups.resolve() or not group.name.startswith("job-") or group.is_symlink():
        raise JailUnavailable("recorded cgroup is outside the configured delegation")
    try:
        uuid.UUID(hex=group.name.removeprefix("job-"))
    except ValueError as error:
        raise JailUnavailable("invalid retained cgroup identity") from error
    if not group.exists():
        return
    (group / "cgroup.kill").write_text("1")
    deadline = time.monotonic() + 5
    while "populated 1" in (group / "cgroup.events").read_text():
        if time.monotonic() >= deadline:
            raise JailUnavailable("recorded cgroup remains populated after kill")
        time.sleep(0.01)
    group.rmdir()
