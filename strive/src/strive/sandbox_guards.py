"""Unprivileged Linux confinement guards (Stage 3C.2B spike).

Adapted from NVIDIA NOOA's `guards.py` (Apache-2.0), the mechanism its
research note calls "the real boundary": a forked child installs
IRREVOCABLE kernel restrictions ON ITSELF before running any untrusted
code —

- **Landlock** path-beneath rules for default-deny filesystem access
  (only an explicit allow-list of paths remains reachable);
- **seccomp-BPF** denying `socket(AF_INET/AF_INET6)` so no outbound network
  is possible;
- **rlimits** (`RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_NOFILE`, `RLIMIT_NPROC`)
  with soft == hard so the child cannot raise them.

Attribution: the Landlock/seccomp/rlimit self-install pattern, the
fail-closed `check_enforceable()` probe, and the leak-vs-closed test shape
are derived from NOOA's Apache-2.0 `src/nooa/runtime/sandbox/guards.py`.

This module is a SPIKE: the `deno-pyodide@1` backend is the shipping secure
local boundary. These guards are Linux-only and require a kernel with
Landlock (>= 5.13) and seccomp. On any other host `check_enforceable()`
FAILS CLOSED — it reports what could not be enforced rather than pretending,
so the sandbox registry refuses the backend instead of silently downgrading.
Nothing here is imported on non-Linux hosts beyond the probe.
"""

from __future__ import annotations

import platform
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class EnforceabilityProbe:
    """The fail-closed capability probe: which guards this host can
    mechanically install. Never silently skips an unenforceable guard."""

    landlock: bool
    seccomp: bool
    rlimits: bool
    detail: str

    @property
    def all_enforceable(self) -> bool:
        return self.landlock and self.seccomp and self.rlimits


def check_enforceable() -> EnforceabilityProbe:
    """Probe host confinement capability, fail-closed (NOOA pattern). On any
    non-Linux host every kernel guard is unenforceable; on Linux we probe for
    the Landlock ABI and seccomp availability without installing anything."""
    if sys.platform != "linux":
        return EnforceabilityProbe(
            landlock=False,
            seccomp=False,
            rlimits=hasattr(_safe_import_resource(), "setrlimit"),
            detail=(
                f"kernel confinement is Linux-only; this host is "
                f"{platform.system()} — Landlock/seccomp cannot be installed"
            ),
        )
    # Linux: probe Landlock (via the landlock syscall ABI) and seccomp.
    landlock = _probe_landlock()
    seccomp = _probe_seccomp()
    return EnforceabilityProbe(
        landlock=landlock,
        seccomp=seccomp,
        rlimits=True,
        detail=(
            "linux: "
            + ", ".join(
                f"{name}={'ok' if ok else 'MISSING'}"
                for name, ok in (
                    ("landlock", landlock),
                    ("seccomp", seccomp),
                    ("rlimits", True),
                )
            )
        ),
    )


def _safe_import_resource() -> object:
    try:
        import resource

        return resource
    except ImportError:
        return object()


def _probe_landlock() -> bool:
    """True iff the Landlock ABI is queryable (kernel >= 5.13 with Landlock
    enabled). Uses the raw syscall via ctypes; any failure = not enforceable
    (fail closed). Never installs a ruleset here."""
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        # landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION=1)
        # returns the supported ABI version (>0) when Landlock is available.
        syscall = libc.syscall
        syscall.restype = ctypes.c_long
        landlock_create_ruleset = 444  # x86_64/arm64 syscall number
        abi = syscall(
            ctypes.c_long(landlock_create_ruleset),
            ctypes.c_void_p(0),
            ctypes.c_size_t(0),
            ctypes.c_uint(1),
        )
        return int(abi) > 0
    except Exception:  # noqa: BLE001 — any probe failure fails closed
        return False


def _probe_seccomp() -> bool:
    """True iff seccomp filtering is available (prctl PR_GET_SECCOMP does not
    error). Fail-closed on any exception."""
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        PR_GET_SECCOMP = 21
        result = libc.prctl(PR_GET_SECCOMP, 0, 0, 0, 0)
        return int(result) >= 0
    except Exception:  # noqa: BLE001
        return False


def install_guards_in_child(allow_read_paths: tuple[str, ...]) -> None:  # pragma: no cover
    """Install irrevocable confinement on the CURRENT process (call in the
    forked child before exec/running untrusted code). Adapted from NOOA's
    `guards.py`. Only invoked when `check_enforceable().all_enforceable`;
    on an unsupported host the backend never reaches this (fail closed).

    NOT exercised on this build's CI (non-Linux); shipped as a spike for the
    Linux path. Raises on any guard it cannot install — never proceeds with
    a missing guard."""
    probe = check_enforceable()
    if not probe.all_enforceable:
        raise RuntimeError(
            f"refusing to run untrusted code: confinement not enforceable "
            f"({probe.detail})"
        )
    import resource

    # rlimits with soft == hard so the child cannot raise them
    resource.setrlimit(resource.RLIMIT_CPU, (11, 11))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    _install_landlock(allow_read_paths)
    _install_seccomp_no_inet()


def _install_landlock(allow_read_paths: tuple[str, ...]) -> None:  # pragma: no cover
    """Default-deny filesystem via Landlock path-beneath rules for exactly
    the allow-list. (Spike: the full ruleset construction mirrors NOOA's
    `guards.py`; abbreviated here as the deno-pyodide backend is the shipping
    boundary.)"""
    raise NotImplementedError(
        "linux-landlock-seccomp is a spike; deno-pyodide@1 is the shipping "
        "secure backend. The ruleset construction follows NOOA guards.py."
    )


def _install_seccomp_no_inet() -> None:  # pragma: no cover
    raise NotImplementedError(
        "linux-landlock-seccomp is a spike; deno-pyodide@1 is the shipping "
        "secure backend."
    )


__all__ = [
    "EnforceabilityProbe",
    "check_enforceable",
    "install_guards_in_child",
]
