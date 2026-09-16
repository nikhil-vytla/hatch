"""Runtime-only resident memory sampling; a watchdog, not an allocation jail."""

import ctypes
import errno
from pathlib import Path
import sys


def resident_bytes(pid: int) -> int:
    if sys.platform == "darwin":
        # Darwin SDK sys/proc_info.h: PROC_PIDTASKINFO=4, six uint64_t
        # followed by twelve int32_t; resident size is the second uint64_t.
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        query = library.proc_pidinfo
        query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        query.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(96)
        size = query(pid, 4, 0, buffer, len(buffer))
        if size == 96:
            return int.from_bytes(buffer.raw[8:16], sys.byteorder)
        if ctypes.get_errno() == errno.ESRCH:
            return 0
        raise OSError(ctypes.get_errno(), "cannot monitor candidate resident memory")
    if sys.platform.startswith("linux"):
        try:
            status = Path(f"/proc/{pid}/status").read_text()
        except FileNotFoundError:
            return 0
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
        return 0  # Reaped/zombie process.
    raise OSError("resident memory monitor requires macOS or Linux")
