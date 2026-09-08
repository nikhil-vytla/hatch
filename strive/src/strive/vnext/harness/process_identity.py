"""Identify a local process before recovery cancellation.

Darwin layout comes from sys/proc_info.h PROC_PIDTBSDINFO. This is an
identity-checked best-effort process-group kill, not an atomic OS jail/pidfd
process-tree guarantee. Native process-tree qualification remains disabled.
"""
import ctypes
import errno
import os
from pathlib import Path
import signal
import sys

from ..codec import decode
from ..contracts.harness import ExecutionContext
from ..errors import VerificationError
from .gateway import ModelGateway


def birth(pid: int) -> str | None:
    if sys.platform == "darwin":
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        query = library.proc_pidinfo
        query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        query.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(136)
        size = query(pid, 3, 0, buffer, len(buffer))
        if size == len(buffer):
            uid = int.from_bytes(buffer.raw[20:24], sys.byteorder)
            start_seconds = int.from_bytes(buffer.raw[120:128], sys.byteorder)
            start_microseconds = int.from_bytes(buffer.raw[128:136], sys.byteorder)
            return f"darwin:{uid}:{start_seconds}:{start_microseconds}"
        if ctypes.get_errno() == errno.ESRCH:
            return None
        raise OSError(ctypes.get_errno(), "cannot establish recovery process identity")
    if sys.platform.startswith("linux"):
        try:
            path = Path(f"/proc/{pid}/stat")
            fields = path.read_text().rsplit(")", 1)[1].split()
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            return f"linux:{path.stat().st_uid}:{boot}:{fields[19]}"
        except FileNotFoundError:
            return None
    raise OSError("recovery process identity requires Darwin or Linux")


def terminate_recorded(gateway: ModelGateway, context: ExecutionContext) -> None:
    # Revoke first, even if identity inspection subsequently fails.
    gateway.revoke(context)
    for reference in gateway.events(context, "pid"):
        value = decode(gateway.objects.read(reference))
        if (not isinstance(value, tuple) or len(value) != 3 or value[0] != "process-identity/1"
                or type(value[1]) is not int or value[1] <= 1
                or not isinstance(value[2], (str, type(None)))):
            raise VerificationError("invalid retained process identity")
        pid, expected = value[1], value[2]
        if expected is None or birth(pid) != expected:
            continue  # Gone or observably reused; the birth-check/kill pair is not atomic.
        try:
            if os.getpgid(pid) != pid:
                raise VerificationError("recorded process is no longer in its fresh session")
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
