"""Native OS attacks use the same jail as candidates and harnesses.

No Deno permissions, Python mocks, RSS monitor or RLIMIT_AS protects these
probes. Kernel error codes and cgroup counters are the evidence.
"""
import errno
import json
import os
from pathlib import Path
import socket
import subprocess

import pytest

from strive.runtime.linux_jail import LinuxJail, capability, settings


def require_jail() -> None:
    detected = capability()
    if not detected.available:
        if os.environ.get("STRIVE_REQUIRE_JAIL") == "1":
            pytest.fail("required OS jail unavailable: " + detected.reason)
        pytest.skip("OS jail deferred: " + detected.reason)


def native_probe(tmp_path: Path, source: str, *, memory: int = 256 * 1024 * 1024,
                 pids: int = 64) -> tuple[subprocess.CompletedProcess[bytes], dict[str, int]]:
    require_jail()
    script = tmp_path / "native-attack.py"
    script.write_text(source)
    with LinuxJail(*settings(), memory_bytes=memory, pids=pids) as jail:
        child = jail.popen(["/usr/local/bin/python3.12", "-I", "-B", "/app/attack.py"], {"attack.py": script})
        try:
            output, error = child.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            jail.kill()
            output, error = child.communicate(timeout=5)
            pytest.fail("native attack exceeded bounded completion: " + error.decode(errors="replace"))
        assert (jail.group / "memory.max").read_text().strip() == str(memory)
        assert (jail.group / "memory.swap.max").read_text().strip() == "0"
        assert (jail.group / "pids.max").read_text().strip() == str(pids)
        events = jail.read_events()
        group = jail.group
    assert not group.exists(), "tree cgroup was not removed after cgroup.kill"
    return subprocess.CompletedProcess(child.args, child.returncode, output, error), events


def assert_native_denials(tmp_path: Path) -> None:
    require_jail()
    tmp_path.mkdir(parents=True, exist_ok=True)
    secret = tmp_path / "host-home/.ssh/id_ed25519"
    secret.parent.mkdir(parents=True)
    secret.write_text("host-only credential")
    host = socket.socket()
    host.bind(("127.0.0.1", 0))
    host.listen(1)
    port = host.getsockname()[1]
    with host:
        result, _ = native_probe(tmp_path, f'''
import ctypes, errno, json, os, platform, socket
from pathlib import Path
errors = {{}}
for name, address in (("host-loopback", ("127.0.0.1", {port})), ("internet", ("192.0.2.1", 443))):
    with socket.socket() as connection:
        connection.settimeout(1)
        try:
            connection.connect(address)
        except OSError as error:
            assert error.errno in (errno.ENETUNREACH, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.EPERM), repr(error)
            errors[name] = error.errno
        else:
            raise AssertionError("escaped private network namespace")
for path in { [str(secret), '/root/.ssh/id_ed25519', '/root/.aws/credentials', '/Users/nikhil/Library/Keychains/login.keychain-db', '/proc/1/root' + str(secret)]!r}:
    try:
        Path(path).read_bytes()
    except OSError as error:
        assert error.errno in (errno.ENOENT, errno.EACCES, errno.EPERM)
        errors[path] = error.errno
    else:
        raise AssertionError("host credentials exposed: " + path)
for path in ("/usr/local/bin/escape", "/app/escape", "/etc/escape"):
    try:
        Path(path).write_text("escape")
    except OSError as error:
        assert error.errno == errno.EROFS, (path, error)
        errors[path] = error.errno
    else:
        raise AssertionError("writable runtime root")
assert "PROVIDER_API_KEY" not in os.environ
libc = ctypes.CDLL(None, use_errno=True)
assert libc.unshare(0x10000000) == -1 and ctypes.get_errno() == errno.EPERM
errors["seccomp-unshare"] = ctypes.get_errno()
# A denied syscall with no privilege requirement proves a filter is installed.
assert libc.getpriority(0, 0) == -1 and ctypes.get_errno() == errno.EPERM
errors["seccomp-getpriority"] = ctypes.get_errno()
try:
    socket.socket(40, socket.SOCK_STREAM)  # AF_VSOCK could reach the VM host.
except OSError as error:
    assert error.errno == errno.EPERM
    errors["seccomp-vsock"] = error.errno
else:
    raise AssertionError("AF_VSOCK admitted")
keyctl = 219 if platform.machine() == "aarch64" else 250
assert libc.syscall(keyctl, 0, 0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
errors["seccomp-keyring"] = ctypes.get_errno()
os.symlink({str(secret)!r}, "/scratch/escape-link")
try:
    Path("/scratch/escape-link").read_bytes()
except OSError as error:
    assert error.errno == errno.ENOENT
else:
    raise AssertionError("symlink reached host home")
print(json.dumps(errors))
''')
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert len(json.loads(result.stdout)) >= 10
    assert secret.read_text() == "host-only credential"


@pytest.mark.parametrize("tree", ["candidate", "harness"])
def test_native_jail_denies_network_files_credentials_and_namespace_escape(tmp_path: Path, tree: str) -> None:
    assert_native_denials(tmp_path / tree)


@pytest.mark.parametrize("tree", ["candidate", "harness"])
def test_cgroup_oom_kills_memory_bomb_without_rss_watchdog(tmp_path: Path, tree: str) -> None:
    require_jail()
    folder = tmp_path / tree
    folder.mkdir()
    result, events = native_probe(folder, '''
blocks = []
while True:
    blocks.append(bytearray(4 * 1024 * 1024))
''', memory=64 * 1024 * 1024)
    assert result.returncode != 0
    assert events["memory.events.oom_kill"] >= 1, (events, result.stderr)
    assert events["memory.events.max"] >= 1


@pytest.mark.parametrize("tree", ["candidate", "harness"])
def test_cgroup_denies_fork_bomb_and_cleans_descendants(tmp_path: Path, tree: str) -> None:
    require_jail()
    folder = tmp_path / tree
    folder.mkdir()
    result, events = native_probe(folder, '''
import errno, json, os, signal, time
children = []
try:
    for _ in range(128):
        try:
            pid = os.fork()
        except OSError as error:
            assert error.errno == errno.EAGAIN, repr(error)
            print(json.dumps({"fork_errno": error.errno, "children": len(children)}), flush=True)
            break
        if pid == 0:
            time.sleep(30)
            os._exit(0)
        children.append(pid)
    else:
        raise AssertionError("pids cap did not stop fork bomb")
finally:
    for pid in children:
        os.kill(pid, signal.SIGKILL)
    for pid in children:
        os.waitpid(pid, 0)
''', pids=16)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert json.loads(result.stdout)["fork_errno"] == errno.EAGAIN
    assert events["pids.events.max"] >= 1, events


def test_tmpfs_enforces_aggregate_storage_quota(tmp_path: Path) -> None:
    result, _ = native_probe(tmp_path, '''
import errno, json
written = 0
try:
    for i in range(100):
        with open('/scratch/f' + str(i), 'wb', buffering=0) as stream:
            written += stream.write(b'x' * 1024 * 1024)
except OSError as error:
    assert error.errno == errno.ENOSPC, repr(error)
    print(json.dumps({"errno": error.errno, "written": written}))
else:
    raise AssertionError("scratch quota not enforced")
''')
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert json.loads(result.stdout)["written"] <= 16 * 1024 * 1024


def test_unavailable_capability_never_claims_enforcement(monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.runtime.linux_jail import _detect
    missing = _detect("linux", "/nonexistent/strive-jail", "/nonexistent/strive-cgroup")
    assert not missing.available and missing.reason
    assert not _detect("darwin", "", "").available
    monkeypatch.setenv("STRIVE_JAIL_HOME", "/nonexistent/strive-jail")
    monkeypatch.setenv("STRIVE_CGROUP_ROOT", "/nonexistent/strive-cgroup")
    monkeypatch.setenv("STRIVE_REQUIRE_JAIL", "1")
    with pytest.raises(RuntimeError, match=".+"):
        LinuxJail.available()


def test_cgroup_kill_covers_descendants_in_new_sessions(tmp_path: Path) -> None:
    require_jail()
    from strive.runtime.linux_jail import terminate_recorded_group
    script = tmp_path / "descendants.py"
    script.write_text("""
import os, time
if os.fork() == 0:
    os.setsid()
    print('descendant-ready', flush=True)
    time.sleep(120)
else:
    time.sleep(120)
""")
    with LinuxJail(*settings()) as jail:
        process = jail.popen(["/usr/local/bin/python3.12", "-I", "/app/tree.py"], {"tree.py": script})
        assert process.stdout is not None
        import selectors
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(10), "descendant did not start"
            assert process.stdout.readline() == b"descendant-ready\n"
        terminate_recorded_group(str(jail.group), Path("/proc/sys/kernel/random/boot_id").read_text().strip())
        process.communicate(timeout=5)
        assert process.returncode != 0 and not jail.group.exists()
