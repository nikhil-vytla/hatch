"""A tiny POSIX rlimit launcher (Stage 3C.2B.1).

Invoked as ``python -m strive.sandbox_launcher <cpu_s> <mem_bytes>
<open_files> <max_procs> <fsize_bytes> -- <cmd> [args...]``. It installs
kernel resource limits (soft == hard, so the child cannot raise them) on
ITSELF and then ``execvp``s the command, so the executed process — the Deno
runtime hosting the candidate — inherits mechanically-enforced ceilings:

- ``RLIMIT_CPU``   — CPU seconds (reliable on macOS and Linux);
- ``RLIMIT_NOFILE``— open file descriptors;
- ``RLIMIT_NPROC`` — child processes (0 permitted → no forking);
- ``RLIMIT_FSIZE`` — bytes any single file write may reach;
- ``RLIMIT_AS``    — address space. A COARSE absolute ceiling on the whole
  Deno+Pyodide runtime (the WASM baseline is hundreds of MB, so this bounds
  runaway allocation rather than giving a tight per-candidate cap), and it
  is unreliable on macOS. Applied best-effort and skipped if the kernel
  rejects the value; the capability report says so.

Stdlib only, so it runs cleanly under the same isolated interpreter the rest
of the harness uses. A limit given as -1 is left unset (accounting only)."""

from __future__ import annotations

import os
import resource
import sys


def _set(limit: int, value: int) -> None:
    if value < 0:
        return
    try:
        resource.setrlimit(limit, (value, value))
    except (ValueError, OSError):
        # a kernel that rejects the value (notably RLIMIT_AS on macOS) must
        # not abort the launch; the backend's capability report is honest
        # about which dimensions are mechanically enforced on this host.
        pass


def main(argv: list[str]) -> int:
    try:
        sep = argv.index("--")
    except ValueError:
        sys.stderr.write("launcher: missing '--' separator\n")
        return 2
    limit_args = argv[:sep]
    command = argv[sep + 1 :]
    if len(limit_args) != 5 or not command:
        sys.stderr.write("launcher: expected 5 limits, '--', then a command\n")
        return 2
    cpu_s, mem_bytes, open_files, max_procs, fsize_bytes = (int(x) for x in limit_args)
    _set(resource.RLIMIT_CPU, cpu_s)
    _set(resource.RLIMIT_NOFILE, open_files)
    if hasattr(resource, "RLIMIT_NPROC"):
        _set(resource.RLIMIT_NPROC, max_procs)
    _set(resource.RLIMIT_FSIZE, fsize_bytes)
    _set(resource.RLIMIT_AS, mem_bytes)
    os.execvp(command[0], command)
    return 0  # unreachable if execvp succeeds


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
