import json
from pathlib import Path
import shutil
from typing import Iterator

import pytest

from strive.codec import content_ref
from strive.contracts.commands import AuthorizedView, Finish
from strive.contracts.primitives import EnvironmentId, ExecutionStatus, RevisionId, ScopedArtifact
from strive.errors import VerificationError
from strive.runtime import SandboxFailure, SandboxLimits
from strive.runtime.confined_sandbox import DenoSandbox

from .runtime_fixtures import RuntimeFixture


# Candidate values use the frozen M2 tagged JSON representation. The parent
# canonicalizes transport whitespace only, then decodes/validates the contract.
RETURN_FINISH = '''return {type: "StepOutput", fields: {
    command: {type: "Finish", fields: {reason: "done"}},
    proposed_private_state: {bytes: btoa("candidate state")},
    annotations: {tuple: []}
}};'''


@pytest.fixture
def sandbox(tmp_path: Path) -> DenoSandbox:
    if shutil.which("deno") is None:
        pytest.skip("Deno required for mechanically confined candidate tests")
    return DenoSandbox(tmp_path / "scratch")


@pytest.fixture
def fixture(tmp_path: Path) -> Iterator[RuntimeFixture]:
    runtime = RuntimeFixture(tmp_path / "store", ("function step() {" + RETURN_FINISH + "}").encode())
    yield runtime
    runtime.close()


def view() -> AuthorizedView:
    return AuthorizedView((), RevisionId("revision"), EnvironmentId("env"), ExecutionStatus.CONTINUE)


def test_confined_candidate_step_connects_to_supervisor(sandbox: DenoSandbox, fixture: RuntimeFixture) -> None:
    fixture.supervisor.step(sandbox)
    assert fixture.reader.verify().execution_status is ExecutionStatus.FINISHED
    assert fixture.supervisor.state.private_state == b"candidate state"
    assert list(sandbox.scratch_root.iterdir()) == []


@pytest.mark.parametrize("attack", ["credentials", "credential_file", "storage", "protected", "escape", "network", "socket", "unix_socket", "subprocess", "ffi", "static_import", "dynamic_import", "worker_import"])
def test_candidate_cannot_access_host_authority_or_escape(sandbox: DenoSandbox, fixture: RuntimeFixture,
                                                         tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                         attack: str) -> None:
    secret = tmp_path / "credential"
    secret.write_text("must stay secret")
    protected = tmp_path / "audit"
    protected.write_text("protected evidence")
    monkeypatch.setenv("PROVIDER_API_KEY", "must stay secret")
    module = tmp_path / "private.js"
    module.write_text('export default "private module";')
    operations = {
        "credentials": 'Deno.env.get("PROVIDER_API_KEY")',
        "credential_file": f'Deno.readTextFile({json.dumps(str(secret))})',
        "socket": 'Deno.connect({hostname:"127.0.0.1", port:8123})',
        "unix_socket": f'Deno.connect({{transport:"unix", path:{json.dumps(str(tmp_path / "private.sock"))}}})',
        "storage": f'Deno.readTextFile({json.dumps(str(fixture.reader.directory / "authority"))})',
        "protected": f'Deno.readTextFile({json.dumps(str(protected))})',
        "escape": f'Deno.writeTextFile({json.dumps(str(secret))}, "overwritten")',
        "network": 'fetch("http://127.0.0.1:8123")',
        "subprocess": 'new Deno.Command("/usr/bin/touch", {args:["escaped"]}).output()',
        "ffi": 'Deno.dlopen("/usr/lib/libSystem.B.dylib", {})',
        "dynamic_import": f'import({json.dumps(module.as_uri())})',
        "worker_import": f'new Promise((resolve,reject)=>{{ const w=new Worker({json.dumps(module.as_uri())}, {{type:"module"}}); w.onerror=e=>{{e.preventDefault();reject(new Error(e.message));}}; setTimeout(resolve,100); }})',
    }
    if attack == "static_import":
        source = f'import secret from {json.dumps(module.as_uri())}; function step() {{ {RETURN_FINISH} }}'
        with pytest.raises(SandboxFailure, match="candidate failed"):
            sandbox.run(source.encode(), view(), b"", None, {})
    else:
        source = f'''async function step() {{
          let blocked = false;
          try {{ await ({operations[attack]}); }} catch (e) {{
            if (!String(e).includes("Requires") && !String(e).includes("NotCapable")) throw e;
            blocked = true;
          }}
          if (!blocked) throw new Error("ATTACK SUCCEEDED");
          {RETURN_FINISH}
        }}'''
        result = sandbox.run(source.encode(), view(), b"", None, {})
        assert isinstance(result.command, Finish)
    assert secret.read_text() == "must stay secret"
    assert protected.read_text() == "protected evidence"
    fixture.reader.verify()
    assert not (sandbox.scratch_root.parent / "escaped").exists()


def test_scoped_input_bytes_only_and_no_inherited_descriptors(sandbox: DenoSandbox, fixture: RuntimeFixture, tmp_path: Path) -> None:
    artifact = ScopedArtifact(fixture.arguments, fixture.scope)
    authorized = AuthorizedView((artifact,), RevisionId("r"), EnvironmentId("e"), ExecutionStatus.CONTINUE)
    source = ('''function step(view, state, result, handles) {
       if (Object.keys(handles).length !== 1) throw Error("extra handles");
       if (atob(Object.values(handles)[0]) !== "approved args") throw Error("wrong bytes");
       for (let fd=3; fd<20; fd++) {
          try { const file = new Deno.FsFile(fd); file.readSync(new Uint8Array(20)); throw Error("inherited fd"); }
          catch(e) { if (String(e).includes("inherited fd")) throw e; }
       }
    ''' + RETURN_FINISH + "}").encode()
    with (tmp_path / "open-secret").open("w+b") as descriptor:
        import os
        os.set_inheritable(descriptor.fileno(), True)
        assert isinstance(sandbox.run(source, authorized, b"", None, {fixture.arguments: b"approved args"}).command, Finish)
    with pytest.raises(VerificationError, match="scoped handles"):
        sandbox.run(source, authorized, b"", None, {fixture.arguments: b"approved args", fixture.pin: b"secret"})
    with pytest.raises(VerificationError, match="scoped handles"):
        sandbox.run(source, authorized, b"", None, {fixture.arguments: b"wrong bytes"})


@pytest.mark.parametrize("source, limits, message", [
    (b"function step(){while(true){}}", SandboxLimits(cpu_seconds=1, wall_seconds=4), "candidate failed"),
    (b"async function step(){await new Promise(r=>setTimeout(r,10000));}", SandboxLimits(wall_seconds=0.2), "wall limit"),
    (b'function step(){while(true)console.log("x".repeat(8192));}', SandboxLimits(output_bytes=4096), "output limit"),
    (b'function step(){let a=[]; while(true)a.push(new Array(100000).fill("x"));}', SandboxLimits(heap_megabytes=16), "candidate failed"),
])
def test_candidate_resource_limits(sandbox: DenoSandbox, source: bytes, limits: SandboxLimits, message: str) -> None:
    sandbox.limits = limits
    with pytest.raises(SandboxFailure, match=message):
        sandbox.run(source, view(), b"", None, {})
    assert list(sandbox.scratch_root.iterdir()) == []


def test_broken_candidate_suspends_and_operator_can_restore(sandbox: DenoSandbox, tmp_path: Path) -> None:
    fixture = RuntimeFixture(tmp_path / "store", b'function step(){throw Error("broken");}')
    try:
        with pytest.raises(SandboxFailure):
            fixture.supervisor.step(sandbox)
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        before = fixture.supervisor.state
        fixture.supervisor.restore(fixture.bundle)
        assert fixture.supervisor.state.active_bundle == fixture.bundle
        assert fixture.reader.verify().execution_status is ExecutionStatus.SUSPENDED
        assert fixture.supervisor.state.effects == before.effects
        assert fixture.supervisor.state.environment == before.environment
        assert fixture.supervisor.state.private_state == before.private_state
    finally:
        fixture.close()


def test_candidate_cannot_return_an_authority_record(sandbox: DenoSandbox) -> None:
    with pytest.raises(SandboxFailure, match="malformed candidate output"):
        sandbox.run(b'function step(){return {type:"EffectAuthorization", fields:{reservation:0}}}', view(), b"", None, {})


def test_sandbox_reports_pinned_enforcement(sandbox: DenoSandbox) -> None:
    profile = sandbox.profile()
    assert profile.executable == content_ref(sandbox.executable.read_bytes())
    assert {"no-host-files", "no-network", "no-env", "no-subprocess", "cpu-rlimit", "output-cap"} <= set(profile.enforced)


def test_production_os_confinement_floor(sandbox: DenoSandbox) -> None:
    from .test_linux_jail import require_jail
    require_jail()
    assert sandbox.profile().production_floor
    assert isinstance(sandbox.run(("function step(){" + RETURN_FINISH + "}").encode(), view(), b"", None, {}).command, Finish)
    assert "memory.events.oom_kill" in sandbox.jail_events


def test_rss_watchdog_includes_arraybuffers_outside_v8_heap(sandbox: DenoSandbox) -> None:
    sandbox.limits = SandboxLimits(resident_megabytes=64)
    source = b'function step(){const a=[];while(true){a.push(new Uint8Array(32*1024*1024).fill(1));}}'
    message = "cgroup memory limit" if sandbox.profile().production_floor else "resident memory limit"
    with pytest.raises(SandboxFailure, match=message):
        sandbox.run(source, view(), b"", None, {})


def test_candidate_time_is_reserved_and_survives_restart(sandbox: DenoSandbox, fixture: RuntimeFixture) -> None:
    from strive.contracts.primitives import Resource
    from strive.runtime.ledger import amounts
    fixture.supervisor.step(sandbox)
    state = fixture.reader.verify()
    assert state.effects[0].authorization.operation == "runtime.step"
    assert amounts(state.effects[0].authorization.reservation.components)[Resource.WALL_MILLISECONDS] == 3000
    assert amounts(state.measured)[Resource.WALL_MILLISECONDS] > 0
    assert not state.obligations
    fixture.restart().recover()
    assert fixture.supervisor.state.measured == state.measured


@pytest.mark.parametrize("boundary", ["accepted", "authorized", "dispatch", "external_return", "return_recorded", "settled", "continuation"])
def test_candidate_step_crash_boundaries(sandbox: DenoSandbox, fixture: RuntimeFixture, boundary: str) -> None:
    from strive.contracts.lifecycle import EffectState
    from strive.runtime import Boundary, Supervisor
    from .test_runtime import Crash, arm
    arm(fixture, Boundary(boundary))
    with pytest.raises(Crash):
        fixture.supervisor.step(sandbox)
    fixture.writer.close()
    fixture.writer = fixture.store.writer(fixture.scope.run_id)
    fixture.supervisor = Supervisor(fixture.writer, fixture.broker, sandbox=sandbox)
    fixture.supervisor.recover()
    state = fixture.reader.verify()
    if boundary in {"authorized", "dispatch", "external_return"}:
        assert state.execution_status is ExecutionStatus.SUSPENDED
        assert state.effects[0].state is EffectState.UNCERTAIN
        assert state.obligations
    else:
        assert state.execution_status is ExecutionStatus.FINISHED
        assert len(state.consumed_results) == 1
        assert state.private_state == b"candidate state"


def test_model_result_is_retained_in_next_sandbox_command(sandbox: DenoSandbox, tmp_path: Path) -> None:
    from strive.contracts.commands import StepOutput
    from strive.contracts.primitives import Resource
    from strive.runtime.ledger import amounts
    fixture = RuntimeFixture(tmp_path / "store", ('''function step(view,state,result,handles) {
        if (!result || atob(handles[result.fields.output.fields.reference.fields.digest]) !== "real outcome")
            throw Error("lost result");
    ''' + RETURN_FINISH + '}').encode())
    try:
        fixture.supervisor.accept(StepOutput(fixture.command(), b"private"), expected_head=fixture.supervisor.state.head)
        fixture.supervisor.drive()
        fixture.supervisor.step(sandbox)
        state = fixture.reader.verify()
        assert len(state.consumed_results) == 2
        assert amounts(state.measured)[Resource.INPUT_TOKENS] == 40
        assert amounts(state.measured)[Resource.WALL_MILLISECONDS] > 0
        assert state.private_state == b"candidate state"
        assert state.execution_status is ExecutionStatus.FINISHED
    finally:
        fixture.close()


def test_resume_rejects_changed_sandbox_limits(sandbox: DenoSandbox, fixture: RuntimeFixture) -> None:
    from strive.runtime import Boundary, Supervisor
    from .test_runtime import Crash, arm
    arm(fixture, Boundary.ACCEPTED)
    with pytest.raises(Crash):
        fixture.supervisor.step(sandbox)
    fixture.writer.close()
    fixture.writer = fixture.store.writer(fixture.scope.run_id)
    sandbox.limits = SandboxLimits(heap_megabytes=128)
    fixture.supervisor = Supervisor(fixture.writer, fixture.broker, sandbox=sandbox)
    with pytest.raises(VerificationError, match="profile or bound changed"):
        fixture.supervisor.recover()
    assert not fixture.reader.verify().effects


def test_supervisor_denies_protected_input_projection(sandbox: DenoSandbox, fixture: RuntimeFixture) -> None:
    with pytest.raises(VerificationError, match="input not permitted"):
        fixture.supervisor.step(sandbox, (ScopedArtifact(fixture.pin, fixture.scope),))
    assert not fixture.reader.verify().effects
