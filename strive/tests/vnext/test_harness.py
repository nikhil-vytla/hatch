"""Deterministic local qualification. No external provider calls or spend."""
import ast
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil

import pytest

from strive.vnext.codec import decode, encode
from strive.vnext.contracts.harness import DurableEvidence, Indeterminate, RecordedReturn
from strive.vnext.contracts.lifecycle import EffectState
from strive.vnext.contracts.primitives import ExecutionStatus, Resource
from strive.vnext.contracts.records import OutcomeStatus
from strive.vnext.errors import VerificationError
from strive.vnext.harness.profiles import NATIVE_RESIDUAL, native_profile
from strive.vnext.runtime import Boundary

from .harness_support import HarnessFixture, ProcessCrash


@pytest.mark.parametrize("backend", ["opencode", "codex", "claude-code"])
def test_fixture_backend_returns_typed_proposal(tmp_path: Path, backend: str) -> None:
    fixture = HarnessFixture(tmp_path, backend)
    try:
        fixture.run()
        effect = fixture.supervisor.state.effects[0]
        assert effect.response is not None
        assert decode(fixture.store.objects.read(effect.response)) == fixture.proposal
        assert not effect.obligations
        assert len(fixture.upstream.requests) == 1
        fixture.consume()
        fixture.restart()
        fixture.execution.recover()
        assert len(fixture.supervisor.state.consumed_results) == 1
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()


@pytest.mark.parametrize("recovery_point", [None, "upstream-return-before-spool", "response-spooled", "harness-return-recorded"])
def test_opencode_codex_parity(tmp_path: Path, recovery_point: str | None) -> None:
    results = []
    for backend in ("opencode", "codex"):
        fixture = HarnessFixture(tmp_path / backend, backend, usage="partial")
        try:
            if recovery_point is not None:
                def crash(actual: str) -> None:
                    if actual == recovery_point:
                        raise ProcessCrash(actual)
                fixture.gateway.fault = crash
                with pytest.raises(ProcessCrash):
                    fixture.run()
                fixture.restart()
                fixture.execution.recover()
            else:
                fixture.run()
            effect = fixture.supervisor.state.effects[0]
            assert effect.response is not None
            fixture.consume()
            fixture.restart()
            fixture.execution.recover()
            results.append((fixture.store.objects.read(effect.response), tuple(q for q in effect.measured if q.resource is not Resource.WALL_MILLISECONDS), effect.obligations,
                            fixture.supervisor.state.private_state, len(fixture.supervisor.state.consumed_results),
                            len(fixture.upstream.requests)))
        finally:
            fixture.close()
    assert results[0] == results[1]


@pytest.mark.parametrize("mode", ["second", "retry", "title", "compaction", "subagent", "auxiliary_first", "tools", "hosted_tools", "wrong_model", "oversize", "billing", "session"])
def test_gateway_denies_hidden_calls_tools_options(tmp_path: Path, mode: str) -> None:
    fixture = HarnessFixture(tmp_path, mode=mode)
    try:
        with pytest.raises(VerificationError):
            fixture.run()
        assert len(fixture.upstream.requests) == int(mode in {"second", "retry", "title", "compaction", "subagent"})
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        assert fixture.supervisor.state.measured or fixture.supervisor.state.obligations
        fixture.restart()
        fixture.execution.recover()
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
    finally:
        fixture.close()


@pytest.mark.parametrize("backend", ["opencode", "codex", "claude-code"])
def test_fixture_process_denies_files_network_tools_credentials(tmp_path: Path, backend: str) -> None:
    fixture = HarnessFixture(tmp_path, backend, mode="escape")
    try:
        fixture.run()
        context = fixture.bridge._context(fixture.supervisor.state.effects[0].authorization)
        state = fixture.gateway.read(context)
        assert state is not None and state.returned is not None
        result = decode(fixture.store.objects.read(state.returned))
        from strive.vnext.contracts.harness import HarnessReturn
        assert isinstance(result, HarnessReturn)
        assert b"ESCAPES_DENIED:9" in fixture.store.objects.read(result.captured_output_references[1])
        launches = fixture.gateway.events(context, "launch")
        assert len(launches) == 1
        assert b"local-fixture-secret" not in fixture.store.objects.read(launches[0])
    finally:
        fixture.close()


@pytest.mark.parametrize("usage", ["complete", "partial", "missing", "overrun"])
def test_usage_uses_provider_receipt_not_harness_totals(tmp_path: Path, usage: str) -> None:
    from typing import cast, Literal
    fixture = HarnessFixture(tmp_path, mode="echo_model", usage=cast(Literal["complete", "partial", "missing", "overrun"], usage))
    try:
        fixture.run()
        state = fixture.supervisor.state
        measured = {q.resource: q.quantity for q in state.measured}
        held = {q.resource: q.quantity for q in state.obligations}
        if usage == "complete":
            assert measured[Resource.INPUT_TOKENS] == 20 and not held
        elif usage == "partial":
            assert measured[Resource.INPUT_TOKENS] == 20 and Resource.INPUT_TOKENS not in held
            assert held[Resource.OUTPUT_TOKENS] == 64 and held[Resource.USD_NANODOLLARS] == 704
        elif usage == "missing":
            assert held[Resource.INPUT_TOKENS] == 256 and held[Resource.OUTPUT_TOKENS] == 64
            fixture.consume()
            fixture.run()  # Budget still covers the retained prior obligation.
            fixture.consume()
            fixture.run()
            fixture.consume()
            with pytest.raises(VerificationError, match="budget"):
                fixture.run()
        else:
            assert state.dispatch_stopped and state.execution_status is ExecutionStatus.SUSPENDED
            assert measured[Resource.INPUT_TOKENS] == 300
    finally:
        fixture.close()


@pytest.mark.parametrize("observed", [None, "unexpected-revision"])
def test_model_echo_is_not_observed_identity(tmp_path: Path, observed: str | None) -> None:
    fixture = HarnessFixture(tmp_path, observed=observed, mode="echo_model")
    try:
        with pytest.raises(VerificationError, match="observed model"):
            fixture.run()
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        context = fixture.bridge._context(fixture.supervisor.state.effects[0].authorization)
        evidence = fixture.gateway.identity_evidence(context)
        assert observed is None or observed.encode() in evidence
        assert fixture.supervisor.state.measured
        assert not fixture.supervisor.state.obligations
    finally:
        fixture.close()


@pytest.mark.parametrize("mode", ["malformed", "forged_output", "crash_after_response"])
def test_bad_harness_output_still_settles_known_usage(tmp_path: Path, mode: str) -> None:
    fixture = HarnessFixture(tmp_path, mode=mode)
    try:
        fixture.run()
        assert fixture.supervisor.state.effects[0].outcome is OutcomeStatus.FAILED
        assert not fixture.supervisor.state.obligations
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()


@pytest.mark.parametrize("point", ["launch-retained", "process-started", "wire-retained", "upstream-before-send", "upstream-return-before-spool", "response-spooled", "harness-return-recorded"])
def test_process_gateway_crash_boundaries(tmp_path: Path, point: str) -> None:
    fixture = HarnessFixture(tmp_path)
    def crash(actual: str) -> None:
        if actual == point:
            raise ProcessCrash(point)
    fixture.gateway.fault = crash
    try:
        with pytest.raises(ProcessCrash):
            fixture.run()
        calls = len(fixture.upstream.requests)
        fixture.restart()
        fixture.execution.recover()
        assert len(fixture.upstream.requests) == calls
        state = fixture.supervisor.state
        if point == "upstream-before-send":
            assert state.execution_status is ExecutionStatus.SUSPENDED and state.obligations
        else:
            assert state.effects[0].state is EffectState.SETTLED
            fixture.consume()
            fixture.restart()
            fixture.execution.recover()
            assert len(fixture.supervisor.state.consumed_results) == 1
        if point == "upstream-return-before-spool":
            assert fixture.upstream.lookups == 1
    finally:
        fixture.close()


@pytest.mark.parametrize("boundary", [Boundary.EXTERNAL_RETURN, Boundary.RETURN_RECORDED, Boundary.SETTLED, Boundary.CONTINUATION])
def test_supervisor_consumes_gateway_result_once(tmp_path: Path, boundary: Boundary) -> None:
    fixture = HarnessFixture(tmp_path)
    def crash(actual: Boundary) -> None:
        if actual is boundary:
            raise ProcessCrash(str(boundary))
    try:
        if boundary is Boundary.CONTINUATION:
            fixture.run()
            fixture.supervisor.fault = crash
            with pytest.raises(ProcessCrash):
                fixture.consume()
        else:
            fixture.supervisor.fault = crash
            with pytest.raises(ProcessCrash):
                fixture.run()
        fixture.restart()
        fixture.execution.recover()
        if not fixture.supervisor.state.consumed_results:
            fixture.consume()
        fixture.restart()
        fixture.execution.recover()
        assert len(fixture.supervisor.state.consumed_results) == 1
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()


def test_unverified_provider_recovery_never_queries_or_retries(tmp_path: Path) -> None:
    fixture = HarnessFixture(tmp_path, lookup=False)
    def crash(point: str) -> None:
        if point == "upstream-return-before-spool":
            raise ProcessCrash(point)
    fixture.gateway.fault = crash
    try:
        with pytest.raises(ProcessCrash):
            fixture.run()
        fixture.restart()
        fixture.execution.recover()
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        assert fixture.supervisor.state.obligations and fixture.upstream.lookups == 0
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()


def test_nondeterministic_decoder_preserves_incomplete(tmp_path: Path) -> None:
    fixture = HarnessFixture(tmp_path, deterministic=False)
    def crash(point: str) -> None:
        if point == "response-spooled":
            raise ProcessCrash(point)
    fixture.gateway.fault = crash
    try:
        with pytest.raises(ProcessCrash):
            fixture.run()
        fixture.restart()
        fixture.execution.recover()
        state = fixture.supervisor.state
        assert state.effects[0].outcome is OutcomeStatus.FAILED
        assert {q.resource for q in state.obligations} == {Resource.WALL_MILLISECONDS}
        assert state.effects[0].response is not None
        from strive.vnext.contracts.harness import HarnessReturn, CompletionClassification
        result = decode(fixture.store.objects.read(state.effects[0].response))
        assert isinstance(result, HarnessReturn) and result.completion_classification is CompletionClassification.INCOMPLETE
    finally:
        fixture.close()


def test_core_unchanged_and_adapters_selected_by_manifest(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    baseline = json.loads((root / "tests/vnext/baselines/core-baseline.json").read_text())
    # Approved changes: scoped admission, suspended operator restoration,
    # the telemetry profile trim, and the contracts architecture docstring link.
    # Preserve the historical baseline for every other core file.
    current = json.loads((root / "tests/vnext/baselines/second-benchmark-core-freeze.json").read_text())
    approved = {"src/strive/vnext/runtime/broker.py", "src/strive/vnext/runtime/supervisor.py",
                "src/strive/vnext/verify/engine.py", "src/strive/vnext/contracts/manifest.py",
                "src/strive/vnext/contracts/__init__.py"}
    assert {name for name in baseline if baseline[name] != current[name]} == approved
    baseline.update({name: current[name] for name in approved})
    for name, digest in baseline.items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
    for path in (root / "src/strive/vnext/harness/adapters").glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert not any(part in (node.module or "").split(".") for part in
                               ("supervisor", "broker", "ledger", "verify", "commands", "workload", "policy"))
    fixture = HarnessFixture(tmp_path, "codex")
    try:
        assert fixture.adapter.describe().backend_name == "codex"
        assert fixture.harness_binding.backend == "codex"
    finally:
        fixture.close()


@pytest.mark.parametrize("backend,executable,version", [("opencode", "opencode", "1.17.18"), ("codex", "codex", "0.153.4"), ("claude-code", "claude", "2.1.263")])
def test_installed_cli_local_drive(tmp_path: Path, backend: str, executable: str, version: str) -> None:
    path = shutil.which(executable)
    if path is None:
        pytest.skip(f"{executable} is not installed")
    profile = native_profile(backend, version, Path(path).resolve(), "recorded-model", "http://127.0.0.1:1")
    assert profile.fixture_script is None
    assert not set(profile.arguments) & {"resume", "--continue", "--session-id", "--resume"}
    pytest.skip(f"{backend}: {NATIVE_RESIDUAL}; native profile has not passed a single-request drive")


@pytest.mark.parametrize("backend", ["opencode", "codex", "claude-code"])
@pytest.mark.skip(reason="funded live smoke: human must set a budget ceiling, provide a qualified OS jail and explicitly enable a separate funded runner; deterministic CI never uses provider credentials")
def test_funded_live_smoke(backend: str) -> None:
    raise NotImplementedError(f"Funded live smoke for {backend} is deferred to a human-budgeted milestone")


@pytest.mark.parametrize("mode", ["hang", "flood", "crash_before_call"])
def test_process_deadline_output_limit_and_early_exit(tmp_path: Path, mode: str) -> None:
    fixture = HarnessFixture(tmp_path, mode=mode)
    try:
        with pytest.raises(VerificationError):
            fixture.run()
        assert not fixture.upstream.requests
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        assert list((fixture.root / "scratch").iterdir()) == []
        assert {q.resource for q in fixture.supervisor.state.obligations} <= {Resource.WALL_MILLISECONDS}
    finally:
        fixture.close()


def test_model_mismatch_still_records_real_usage_and_overrun(tmp_path: Path) -> None:
    fixture = HarnessFixture(tmp_path, usage="overrun", observed="unexpected")
    try:
        with pytest.raises(VerificationError, match="observed model"):
            fixture.run()
        state = fixture.supervisor.state
        assert state.dispatch_stopped and state.execution_status is ExecutionStatus.SUSPENDED
        assert any(q.resource is Resource.INPUT_TOKENS and q.quantity == 300 for q in state.measured)
        fixture.restart()
        fixture.execution.recover()
        assert fixture.gateway.stop_reason(fixture.scope.run_id) is not None
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()
