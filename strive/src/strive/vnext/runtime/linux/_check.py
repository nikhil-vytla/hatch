"""Executed inside the jail before every payload; failure never runs payload."""
import ctypes
import errno
import json
import os
from pathlib import Path
import sys


def attest(expected: dict[str, object]) -> dict[str, object]:
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    assert status["NoNewPrivs"].strip() == "1", "no-new-privs absent"
    assert status["Seccomp"].strip() == "2", "seccomp filter absent"
    assert all(int(status[name].strip(), 16) == 0 for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")), "payload retains capabilities"
    assert os.getuid() == os.getgid() == 65534, "unexpected jail identity"
    mapping = Path("/proc/self/uid_map").read_text().split()
    assert len(mapping) == 3 and mapping[0] == "65534" and mapping[2] == "1", "broad uid map"
    assert mapping[1] == str(expected["host_uid"]), "wrong mapped host identity"
    group_map = Path("/proc/self/gid_map").read_text().split()
    assert group_map == ["65534", str(expected["host_gid"]), "1"], "unexpected gid map"
    namespaces = {name: os.readlink("/proc/self/ns/" + name) for name in ("user", "mnt", "pid", "net", "ipc", "uts")}
    parent = expected["namespaces"]
    assert isinstance(parent, dict)
    assert all(namespaces[name] != parent[name] for name in namespaces), "namespace shared with parent"
    assert os.statvfs("/").f_flag & os.ST_RDONLY, "writable rootfs"
    assert os.statvfs("/app").f_flag & os.ST_RDONLY, "writable payload mounts"
    scratch = os.statvfs("/scratch")
    assert scratch.f_blocks * scratch.f_frsize <= int(str(expected["scratch_bytes"])), "scratch quota absent"
    assert not Path("/sys/fs/cgroup").exists(), "cgroup controls exposed"
    interfaces = {line.split(":", 1)[0].strip() for line in Path("/proc/net/dev").read_text().splitlines() if ":" in line}
    assert interfaces <= {"lo"}, "network interface beyond isolated loopback"
    assert len(Path("/proc/net/route").read_text().splitlines()) == 1, "IP egress route present"
    library = ctypes.CDLL(None, use_errno=True)
    assert library.getpriority(0, 0) == -1 and ctypes.get_errno() == errno.EPERM, "default-deny seccomp probe failed"
    # /proc is from the private pid namespace, never the supervisor's procfs.
    assert not Path("/proc/1/root/root/.ssh").exists()
    return {"status": "enforced", "uid_map": mapping, "namespaces": namespaces,
            "seccomp": 2, "no_new_privs": 1, "root_readonly": True,
            "scratch_bytes": scratch.f_blocks * scratch.f_frsize}


if __name__ == "__main__":
    evidence = attest(json.loads(sys.argv[1]))
    if len(sys.argv) == 2:
        print(json.dumps(evidence))
    else:
        os.execv(sys.argv[2], sys.argv[2:])
