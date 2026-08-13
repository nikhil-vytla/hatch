"""Stage 3C.2B: the pluggable sandbox boundary and the secure local backend.

The adversarial core: a battery of escape attempts run through the shipping
secure backend (`deno-pyodide@1`), each of which must be MECHANICALLY DENIED
while the case still returns a normal failure-as-data outcome — read the
repo / task answers / ledger / CAS / environment / SSH config / sibling case
data / caller frames; open internet sockets; fork children; write outside
the workspace; persist state across cases; flood output; and exceed limits.

Plus the boundary contracts: the registry fails closed and never downgrades;
capability reports and per-execution provenance are honest and distinct
between backends.

These tests require `deno` on PATH; they skip (never silently pass) when it
is absent, so CI without deno does not give false assurance.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import strive.sandbox_backends  # noqa: F401 — registers backends
from strive.contracts import TaskCase
from strive.sandboxes import (
    SECURE_EXECUTION_CAPABILITIES,
    SandboxError,
    SandboxRequest,
    get_backend,
    known_backends,
    run_protected_suite,
)

DENO = get_backend("deno-pyodide@1", require_available=False)
_available, _reason = DENO.available()
requires_deno = pytest.mark.skipif(
    not _available, reason=f"deno-pyodide unavailable: {_reason}"
)


def _case(cid: str = "c", text: str = "1 2 3") -> TaskCase:
    return TaskCase(cid, text, 6, "held_out")


def _run(source: str, text: str = "1 2 3") -> tuple[object, str | None]:
    """Run a one-case suite; return (output, error)."""
    outcomes, _prov, _denials = run_protected_suite(
        DENO, source, (_case("c", text),), generation_id="adv"
    )
    o = outcomes["c"]
    return o.output, o.error


# -- registry: fail-closed, never downgrades -----------------------------------------------------


def test_registry_knows_the_three_backends() -> None:
    assert set(known_backends()) == {
        "process-fault-only@1",
        "deno-pyodide@1",
        "linux-landlock-seccomp@1",
    }


def test_unknown_backend_fails_closed() -> None:
    with pytest.raises(SandboxError, match="unknown sandbox backend"):
        get_backend("totally-made-up@1")


def test_unavailable_backend_is_never_downgraded() -> None:
    """A requested-but-unavailable secure backend raises rather than handing
    back a weaker one — no silent downgrade."""
    landlock = get_backend("linux-landlock-seccomp@1", require_available=False)
    available, _reason = landlock.available()
    if available:  # on a real Linux kernel this backend IS available
        pytest.skip("landlock backend is available on this host")
    with pytest.raises(SandboxError, match="unavailable|downgrade"):
        get_backend("linux-landlock-seccomp@1")


def test_process_fault_only_reports_its_gaps_honestly() -> None:
    caps = get_backend("process-fault-only@1").capabilities()
    assert not caps.secure
    assert "filesystem_confined" in caps.not_enforced
    assert "network_denied" in caps.not_enforced


def test_deno_backend_declares_secure_capabilities() -> None:
    caps = DENO.capabilities()
    for capability in SECURE_EXECUTION_CAPABILITIES:
        assert capability in caps.enforced, capability
    assert caps.secure


# -- the adversarial battery (each attack mechanically denied) ------------------------------------


@requires_deno
def test_cannot_read_the_repository() -> None:
    repo = Path(__file__).resolve().parents[1] / "src" / "strive" / "loop.py"
    out, err = _run(
        f"def solve(t):\n    return len(open({str(repo)!r}).read())"
    )
    assert out is None and err is not None  # denied, surfaced as failure-as-data


@requires_deno
def test_cannot_read_task_answers_or_sibling_cases() -> None:
    # the candidate is handed ONLY input_text; there is no object holding the
    # expected output or the other cases inside the sandbox
    src = (
        "def solve(t):\n"
        "    found = []\n"
        "    for name in ('expected','cases','_payload','answers'):\n"
        "        found.append(name in dir())\n"
        "    return int(any(found))"
    )
    out, err = _run(src)
    assert out == 0  # none of those names are reachable


@requires_deno
def test_cannot_read_ledger_cas_or_home() -> None:
    for path in ("/Users", "/home", "/root/.ssh/config", "/etc/passwd"):
        out, err = _run(f"def solve(t):\n    return len(open({path!r}).read())")
        assert out is None and err is not None, path


@requires_deno
def test_cannot_read_host_environment() -> None:
    # the WASM env holds only Pyodide's own web_user vars, never host secrets
    src = (
        "import os\n"
        "def solve(t):\n"
        "    leaked = [k for k in os.environ if 'KEY' in k.upper() "
        "or 'TOKEN' in k.upper() or 'SECRET' in k.upper()]\n"
        "    return len(leaked)"
    )
    out, err = _run(src)
    assert out == 0


@requires_deno
def test_cannot_open_internet_socket() -> None:
    src = (
        "import socket\n"
        "def solve(t):\n"
        "    s = socket.socket()\n"
        "    s.connect(('1.1.1.1', 80))\n"
        "    return 1"
    )
    out, err = _run(src)
    assert out is None and err is not None


@requires_deno
def test_cannot_fork_or_spawn_subprocess() -> None:
    for attack in (
        "import os\ndef solve(t):\n    return os.fork()",
        "import subprocess\ndef solve(t):\n    return subprocess.run(['ls']).returncode",
    ):
        out, err = _run(attack)
        assert out is None and err is not None, attack


@requires_deno
def test_cannot_write_outside_workspace() -> None:
    out, err = _run(
        "def solve(t):\n    open('/etc/pwned','w').write('x')\n    return 1"
    )
    assert out is None and err is not None


@requires_deno
def test_cannot_inspect_caller_frames_for_host_state() -> None:
    # inspect works, but the stack contains only Pyodide/runner frames — no
    # strive controller frame is reachable to walk to the store
    src = (
        "import inspect\n"
        "def solve(t):\n"
        "    files = [f.filename for f in inspect.stack()]\n"
        "    return int(any('strive' in f for f in files))"
    )
    out, err = _run(src)
    assert out == 0


@requires_deno
def test_state_does_not_persist_across_cases() -> None:
    """Each protected case runs in a FRESH sandbox: a global written on one
    case is absent on the next."""
    src = (
        "import builtins\n"
        "def solve(t):\n"
        "    prev = getattr(builtins, '_leak', None)\n"
        "    builtins._leak = t\n"
        "    return 1 if prev is None else 999"
    )
    cases = (_case("a", "1 2 3"), _case("b", "1 2 3"))
    outcomes, _prov, _denials = run_protected_suite(
        DENO, src, cases, generation_id="persist"
    )
    # if state leaked, the second case would see prev != None and return 999
    assert outcomes["a"].output == 1 and outcomes["b"].output == 1


@requires_deno
def test_output_flood_is_bounded_or_denied() -> None:
    # a candidate that returns a valid int but printed a flood still yields a
    # usable outcome; a candidate that returns a huge object is handled, not
    # allowed to OOM the controller
    src = (
        "def solve(t):\n"
        "    for _ in range(1000):\n"
        "        print('x' * 1000)\n"
        "    return 6"
    )
    out, err = _run(src)
    assert out == 6 or err is not None  # never crashes the controller


@requires_deno
def test_infinite_loop_does_not_hang_controller() -> None:
    from strive.sandboxes import SandboxLimits

    src = "def solve(t):\n    while True:\n        pass"
    outcomes, _prov, _denials = run_protected_suite(
        DENO, src, (_case(),), generation_id="loop",
        limits=SandboxLimits(wall_time_s=3.0),
    )
    # the controller returns (deno/pyodide caps execution); the case is a
    # failure-as-data outcome, not a hung process
    assert outcomes["c"].error is not None or outcomes["c"].output is None


# -- honest compute + provenance ------------------------------------------------------------------


@requires_deno
def test_correct_candidate_computes_correctly() -> None:
    out, err = _run("def solve(t):\n    return sum(int(x) for x in t.split())")
    assert out == 6 and err is None


@requires_deno
def test_provenance_names_the_exact_backend_and_capabilities() -> None:
    result = DENO.run(
        SandboxRequest(
            strategy_source="def solve(t):\n    return 0",
            cases=(_case(),),
            generation_id="prov",
        )
    )
    prov = result.provenance
    assert prov.backend == "deno-pyodide@1"
    assert "pyodide" in prov.runtime_digest
    assert "network_denied" in prov.enforced_capabilities
    assert "no --allow-net" in prov.network_policy


def test_backend_provenance_is_distinct_between_backends() -> None:
    from strive.sandboxes import SandboxLimits

    limits = SandboxLimits()
    fault_prov = get_backend("process-fault-only@1").provenance(limits)
    deno_prov = DENO.provenance(limits)
    assert fault_prov.backend != deno_prov.backend
    assert fault_prov.enforced_capabilities != deno_prov.enforced_capabilities
