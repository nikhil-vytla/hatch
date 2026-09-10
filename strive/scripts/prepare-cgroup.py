"""Initialize delegation only in an explicitly requested private container cgroup.

Never mount the host cgroup tree into this container. The runner must supply
--cgroupns=private and a writable cgroup2 mount (normally --privileged).
"""
import os
from pathlib import Path

root = Path("/sys/fs/cgroup")
if os.environ.get("STRIVE_PRIVATE_CONTAINER_CGROUP") != "1":
    raise SystemExit("private container cgroup opt-in required; see README command")
if Path("/proc/self/cgroup").read_text().strip() not in {"0::/", "0::/strive-supervisor"}:
    raise SystemExit("expected private cgroup namespace rooted at this container")
if not (Path("/.dockerenv").exists() or Path("/run/.containerenv").exists()):
    raise SystemExit("refusing cgroup setup outside a recognized container")
if not {"memory", "pids"} <= set((root / "cgroup.controllers").read_text().split()):
    raise SystemExit("container has no delegated memory/pids controllers")
# The cgroup v2 no-internal-process rule requires the runner in a sibling leaf.
supervisor = root / "strive-supervisor"
supervisor.mkdir(exist_ok=True)
for pid in (root / "cgroup.procs").read_text().split():
    try:
        (supervisor / "cgroup.procs").write_text(pid)
    except ProcessLookupError:
        pass
(root / "cgroup.subtree_control").write_text("+memory +pids")
jobs = Path(os.environ["STRIVE_CGROUP_ROOT"])
if jobs.parent != root:
    raise SystemExit("unexpected cgroup root: refusing external delegation mutation")
jobs.mkdir(exist_ok=True)
(jobs / "cgroup.subtree_control").write_text("+memory +pids")
print("Delegated cgroups v2 memory/pids:", jobs)
