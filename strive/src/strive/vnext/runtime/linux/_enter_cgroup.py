"""Trusted pre-exec shim. Join the already limited cgroup before any fork."""
import ctypes
import os
from pathlib import Path
import sys

if __name__ == "__main__":
    # Do not survive a supervisor dying between Popen and cgroup attachment.
    library = ctypes.CDLL(None, use_errno=True)
    if library.prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != int(sys.argv[1]):
        raise RuntimeError("supervisor disappeared before jail entry")
    group = Path(sys.argv[2])
    (group / "cgroup.procs").write_text(str(os.getpid()))
    if str(os.getpid()) not in (group / "cgroup.procs").read_text().split():
        raise RuntimeError("failed to enter confinement cgroup")
    os.execv(sys.argv[3], sys.argv[3:])
