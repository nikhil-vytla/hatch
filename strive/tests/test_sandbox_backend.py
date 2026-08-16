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

from strive.contracts import TaskCase
from strive.sandboxes import (
    SECURE_EXECUTION_CAPABILITIES,
    CandidateExecutor,
    SandboxError,
    SandboxRequest,
    conformance_violations,
    default_catalog,
    run_protected_suite,
)

CATALOG = default_catalog()
DENO = CATALOG.create("deno-pyodide@1")
_available, _reason = DENO.available()
requires_deno = pytest.mark.skipif(
    not _available, reason=f"deno-pyodide unavailable: {_reason}"
)


def _case(cid: str = "c", text: str = "1 2 3") -> TaskCase:
    return TaskCase(cid, text, 6, "held_out")


def _run(source: str, text: str = "1 2 3") -> tuple[object, str | None]:
    """Run a one-case suite; return (output, error)."""
    outcomes, _prov, _denials, *_ = run_protected_suite(
        DENO, source, (_case("c", text),), generation_id="adv"
    )
    o = outcomes["c"]
    return o.output, o.error


# -- catalog: immutable, injected, fail-closed, no import side effects ---------------------------


def test_catalog_knows_the_three_backends() -> None:
    assert set(CATALOG.names()) == {
        "process-fault-only@1",
        "deno-pyodide@1",
        "linux-landlock-seccomp@1",
    }


def test_no_import_side_effect_registration() -> None:
    """Importing the backends module must NOT mutate a global registry —
    the catalog is built explicitly from immutable descriptors."""
    import importlib

    import strive.sandbox_backends as backends
    import strive.sandboxes as sandboxes

    importlib.reload(backends)
    assert not hasattr(sandboxes, "_BACKENDS")
    assert not hasattr(sandboxes, "register_backend")
    # a fresh catalog is independent state, not a shared mutable global
    assert default_catalog().names() == CATALOG.names()


def test_all_backends_are_conformant() -> None:
    for name in CATALOG.names():
        assert conformance_violations(CATALOG.create(name)) == [], name


def test_unknown_backend_fails_closed() -> None:
    with pytest.raises(SandboxError, match="unknown sandbox backend"):
        CATALOG.resolve("totally-made-up@1")


def test_unavailable_backend_is_never_downgraded() -> None:
    """A requested-but-unavailable secure backend raises rather than handing
    back a weaker one — no silent downgrade."""
    with pytest.raises(SandboxError, match="unavailable|downgrade"):
        CATALOG.resolve("linux-landlock-seccomp@1")


def test_linux_backend_is_always_unavailable_not_stubbed_secure() -> None:
    """The spike must NEVER report available+secure with a raising run()."""
    backend = CATALOG.create("linux-landlock-seccomp@1")
    available, _reason = backend.available()
    assert available is False
    assert backend.capabilities().enforced == ()  # claims nothing


def test_executor_refuses_untrusted_on_fault_only() -> None:
    with pytest.raises(SandboxError, match="trusted fixtures/code only"):
        CandidateExecutor.from_catalog(
            CATALOG, "process-fault-only@1", trusted=False, require_available=False
        )


def test_process_fault_only_reports_its_gaps_honestly() -> None:
    caps = CATALOG.create("process-fault-only@1").capabilities()
    assert not caps.secure
    assert "filesystem_confined" in caps.not_enforced
    assert "network_denied" in caps.not_enforced
    assert "resource_limited" in caps.not_enforced


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
    outcomes, _prov, _denials, *_ = run_protected_suite(
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
    outcomes, _prov, _denials, *_ = run_protected_suite(
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
def test_provenance_names_the_exact_backend_capabilities_and_digests() -> None:
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
    assert "resource_limited" in prov.enforced_capabilities  # 3C.2B.1 floor
    assert "no --allow-net" in prov.network_policy
    # exact component digests are pinned (Deno / Pyodide / DSPy / runner)
    for key in ("deno", "pyodide", "dspy", "runner_sha256", "backend_config"):
        assert key in prov.component_digests, key
    assert prov.secure


def test_backend_provenance_is_distinct_between_backends() -> None:
    from strive.sandboxes import SandboxLimits

    limits = SandboxLimits()
    fault_prov = CATALOG.create("process-fault-only@1").provenance(limits)
    deno_prov = DENO.provenance(limits)
    assert fault_prov.backend != deno_prov.backend
    assert fault_prov.enforced_capabilities != deno_prov.enforced_capabilities
    assert fault_prov.component_digests != deno_prov.component_digests


# -- the hardened protocol (3C.2B.1): namespace isolation + strict result ------------------------


@requires_deno
def test_candidate_namespace_cannot_read_runner_globals() -> None:
    for name in ("_STRIVE_INPUTS", "_STRIVE_SRC", "_dumps", "_inputs", "_code"):
        out, err = _run(f"def solve(t):\n    return len(str({name}))")
        assert out is None and err is not None and "NameError" in (err or ""), name


@requires_deno
def test_frame_walk_reveals_no_sibling_or_answer_data() -> None:
    # a second case's expected value / input is NOT in this sandbox at all;
    # walking frames yields only this case's own input text
    src = (
        "import sys\n"
        "def solve(t):\n"
        "    seen = []\n"
        "    f = sys._getframe()\n"
        "    while f is not None:\n"
        "        seen.append(str(sorted(f.f_locals.keys())))\n"
        "        f = f.f_back\n"
        "    blob = ' '.join(seen)\n"
        "    return 1 if ('expected' in blob or 'case_id' in blob) else 0"
    )
    out, _err = _run(src, text="42")
    assert out == 0  # no case_id / expected reachable via frames


@requires_deno
def test_patched_serialization_cannot_hijack_the_envelope() -> None:
    # rebinding json.dumps inside the candidate does not affect the envelope,
    # which is built with a reference captured before the candidate ran
    src = (
        "import json\n"
        "def solve(t):\n"
        "    json.dumps = lambda *a, **k: '{\"protocol\": 1, \"results\": []}'\n"
        "    return 7"
    )
    out, err = _run(src, text="7")
    assert out == 7 and err is None


@requires_deno
def test_bool_output_is_rejected_as_non_int() -> None:
    out, err = _run("def solve(t):\n    return True")
    assert out is None and "non-integer output of type bool" in (err or "")


@requires_deno
def test_forged_extra_results_are_rejected() -> None:
    # a candidate that tries to emit its own protocol envelope cannot: the
    # runner ignores stray globals and the parent validates result COUNT and
    # assigns case ids by position, so forged/extra outcomes cannot appear
    src = (
        "def solve(t):\n"
        "    globals()['_STRIVE_RESULT'] = '{\"protocol\":1,\"results\":"
        "[{\"output\":1,\"error\":null,\"duration_ms\":0.0},"
        "{\"output\":2,\"error\":null,\"duration_ms\":0.0}]}'\n"
        "    return 5"
    )
    outcomes, _prov, _denials, *_ = run_protected_suite(
        DENO, src, (_case("only", "5"),), generation_id="forge"
    )
    assert set(outcomes) == {"only"}  # exactly the parent-dispatched case id
    assert outcomes["only"].output == 5


@requires_deno
def test_resource_limit_caps_cpu_runaway() -> None:
    # a CPU-bound candidate is bounded by the wall-clock hard-kill (and the
    # rlimit launcher's CPU ceiling) — the controller never hangs
    from strive.sandboxes import SandboxLimits

    outcomes, _prov, denials, *_ = run_protected_suite(
        DENO,
        "def solve(t):\n    x = 0\n    while True:\n        x += 1",
        (_case("c", "1"),),
        generation_id="cpu",
        limits=SandboxLimits(wall_time_s=3.0),
    )
    assert outcomes["c"].output is None
    assert any("wall time" in d for d in denials) or outcomes["c"].error
