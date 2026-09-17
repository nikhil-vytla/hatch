"""No-spend tests run the live composition with scripted provider receipts."""
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import os
import shutil
import threading

import pytest

from strive.benchmarks.api import BenchmarkAdapter, TaskSpec
from strive.benchmarks.json_data import canonical, obj, parse
from strive.benchmarks.store import OperationStore
from strive.cli.budget_proof import prove, dispatches
from strive.cli.campaign import Campaign
from strive.contracts.primitives import ArtifactRef, RunId, Resource
from strive.errors import VerificationError
from strive.harness.openai_live import OpenAIContract, OpenAITransport, CONTROLS, load_contract, network_namespace
from strive.harness.profiles import fixture_profile
from strive.harness.provider import Upstream
from strive.runtime.ledger import amounts
from strive.store.cas import CAS
from strive_benchmark_tau2.adapter import Tau2Adapter, implementation_identity
from strive_benchmark_tau2.qualification import qualify
from strive_benchmark_tau2.splits import scenario_group
from .benchmark_fixtures import SyntheticTelecom, inventory

ROOT = Path(__file__).resolve().parents[2]
PRICE = ROOT / "tests/vnext/fixtures/budget-proof/prices/openai-2026-09-10.json"


class CampaignBackend(SyntheticTelecom):
    def call(self, operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]:
        if operation == "actor_view":
            return state or b"{}", canonical({"policy": "Be helpful", "tools": [], "messages": []})
        if operation == "plan_user_turn":
            return state or b"{}", canonical({"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "hello"}],
                                              "tools": [], "settings": {}})
        raw, output = super().call(operation, state, payload)
        if operation == "user_turn":
            data = obj(parse(raw))
            data["pending_message"] = None
            raw = canonical(data)
        return raw, output


class ScriptedProvider:
    def __init__(self, contract: OpenAIContract, owner: "Setup") -> None:
        self.contract, self.owner = contract, owner

    def generate(self, request: bytes, operation_key: str) -> bytes:
        # Also exercised by the real native-jail qualification in the container.
        assert os.getpid() == self.owner.parent_pid
        assert threading.get_ident() == self.owner.parent_thread
        assert network_namespace() == self.owner.parent_netns
        self.contract.validate(request)
        # The callback runs only after M3 committed authorization and forward.
        state = self.owner.campaign.reader.verify()
        assert state.effects[-1].authorization.actual_provider_request_reference is not None
        assert amounts(state.obligations)[Resource.USD_NANODOLLARS] >= 7_782_400
        self.owner.calls.append(operation_key)
        text = "hello" if self.contract.user else ('{"message":"hello"}' if len(self.owner.calls) == 1 else '{"stop":true}')
        return canonical({"id": "resp-scripted-" + str(len(self.owner.calls)), "model": "gpt-5.6-luna", "status": "completed",
            "service_tier": "default", "usage": {"input_tokens": self.owner.input_tokens,
                "output_tokens": 1025 if self.owner.overrun else self.owner.output_tokens,
                "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 20}},
            "output": [{"type": "reasoning", "summary": []}, {"type": "message", "content": [{"type": "output_text", "text": text}]}]})

    def lookup(self, operation_key: str) -> bytes | None:
        raise AssertionError("no provider redispatch/lookup permitted")


class Setup:
    def __init__(self, root: Path, *, cap: str = "0.0155648") -> None:
        self.parent_pid, self.parent_thread = os.getpid(), threading.get_ident()
        self.parent_netns = network_namespace()
        self.root, self.calls = root, list[str]()
        self.overrun = False
        self.input_tokens, self.output_tokens = 32768, 1024
        self.tasks: tuple[str, ...] = ("0",)
        deno = shutil.which("deno")
        assert deno
        self.launch = fixture_profile("opencode", Path(deno), Path(__file__).with_name("harness_fixtures") / "campaign.js")
        self.manifest = root / "pilot.toml"
        source = (ROOT / "tests/vnext/fixtures/budget-proof/pilot-5usd.toml").read_text()
        self.manifest.write_text(source.replace('usd = 5.00', 'usd = ' + cap).replace('version = "1.18.30"', 'version = "fixture/1"')
            .replace('deadline_seconds = 150', 'deadline_seconds = 10').replace('prices/openai-2026-09-10.json', str(PRICE)))
        self.backend = CampaignBackend(ArtifactRef("sha256:" + "a" * 64))
        self.operations: OperationStore | None = None

    def open(self, *, resume: bool = False, native: bool = False) -> Campaign:
        def factory(objects: CAS, epoch: int, creating: bool) -> BenchmarkAdapter:
            pin = objects.publish(b"explicitly synthetic telecom fixture")
            self.backend.identity = pin
            tasks, splits = inventory()
            qualification = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}),
                                    execute_checks=lambda task: None)
            specs = tuple(TaskSpec(str(t["id"]), scenario_group(t), objects.publish(canonical(t)),
                        objects.publish(canonical(t["evaluation_criteria"]))) for t in tasks)
            identity = implementation_identity(objects, self.backend, qualification, pin)
            self.operations = OperationStore(self.root / "operations", objects, RunId("campaign"), identity, epoch, create=creating)
            return Tau2Adapter(objects, self.backend, specs, qualification, pin, self.operations)
        def provider(contract: OpenAIContract, objects: CAS, path: Path) -> Upstream:
            return ScriptedProvider(contract, self)
        self.campaign = Campaign(self.root / "run", "campaign", self.manifest, factory, self.backend.call,
            self.tasks, {"0": b"[]"}, self.launch, providers=provider, native=native, resume=resume)
        return self.campaign

    def close(self) -> None:
        if hasattr(self, "campaign"):
            self.campaign.resources.close()
        if self.operations:
            self.operations.close()


def test_campaign_exact_ceiling_stop_and_restart_no_dispatch(tmp_path: Path) -> None:
    setup = Setup(tmp_path)
    try:
        campaign = setup.open()
        result = campaign.drive()
        assert result["budget_stopped"] is True
        assert result["settled_usd"] == float(Decimal("0.0155648"))
        assert len(setup.calls) == 2  # actor and user share the SAME ledger
        evidence = prove(campaign, real=False)
        assert evidence["dispatches_after_stop"] == 0
        snapshot = campaign.supervisor.state.environment
        setup.close()
        campaign = setup.open(resume=True)
        assert campaign.drive()["budget_stopped"] is True
        assert campaign.supervisor.state.environment == snapshot
        assert len(setup.calls) == dispatches(campaign.directory) == 2
    finally:
        setup.close()


def test_mid_episode_pause_resumes_and_scores_without_repeating_model(tmp_path: Path) -> None:
    setup = Setup(tmp_path, cap="0.10")
    try:
        campaign = setup.open()
        campaign.drive(transitions=3)
        before = len(setup.calls)
        assert before == 1
        setup.close()
        campaign = setup.open(resume=True)
        result = campaign.drive()
        assert result["completed_episodes"] == 1 and result["status"] == "finished"
        assert len(setup.calls) == 3 and len(set(setup.calls)) == 3
    finally:
        setup.close()


def test_campaign_releases_unused_reservation_and_prices_actual_usage(tmp_path: Path) -> None:
    setup = Setup(tmp_path, cap="0.01")
    setup.input_tokens, setup.output_tokens = 1000, 100
    setup.tasks = ("0",) * 8
    try:
        campaign = setup.open()
        result = campaign.drive()
        # Actual receipts cost $0.00032; each next call must still fit the
        # $0.0077824 bound. Seven fit, then 0.00224 + 0.0077824 > 0.01.
        assert len(setup.calls) == 7
        assert result["settled_usd"] == 0.00224
        assert result["outstanding_usd"] == 0
        assert result["budget_stopped"] is True
        assert prove(campaign, real=False)["dispatches_after_stop"] == 0
    finally:
        setup.close()


def test_resume_cannot_replace_single_budget(tmp_path: Path) -> None:
    setup = Setup(tmp_path)
    campaign = setup.open()
    campaign.drive()
    setup.close()
    setup.manifest.write_text(setup.manifest.read_text().replace("usd = 0.0155648", "usd = 5.00"))
    with pytest.raises(VerificationError, match="resume configuration"):
        setup.open(resume=True)
    if setup.operations:
        setup.operations.close()


def test_real_shaped_receipt_reconciliation_and_unknowns(tmp_path: Path) -> None:
    objects = CAS(tmp_path)
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    receipt = {"model": contract.model, "service_tier": "default", "usage": {"input_tokens": 1000, "output_tokens": 100,
        "input_tokens_details": {"cached_tokens": 200, "cache_write_tokens": 300}, "output_tokens_details": {"reasoning_tokens": 80}}}
    assert amounts(contract.usage(canonical(receipt)))[Resource.USD_NANODOLLARS] == 500*200 + 200*20 + 300*250 + 100*1200
    receipt["service_tier"] = "priority"
    assert Resource.USD_NANODOLLARS not in amounts(contract.usage(canonical(receipt)))
    receipt["service_tier"], receipt["model"] = "default", "unpriced-model"
    assert Resource.USD_NANODOLLARS not in amounts(contract.usage(canonical(receipt)))
    assert Resource.USD_NANODOLLARS not in amounts(contract.usage(b'{"usage":{}}'))
    with pytest.raises(VerificationError, match="pinned tier"):
        contract.validate(canonical({"model": contract.model, "input": "hello", "max_output_tokens": 10}))
    with pytest.raises(VerificationError):
        contract.validate(canonical({**CONTROLS, "model": contract.model, "input": "hello", "max_output_tokens": 1025}))


def test_live_transport_refuses_macos_before_reading_key(tmp_path: Path) -> None:
    import sys
    if sys.platform == "linux":
        pytest.skip("macOS refusal test")
    objects = CAS(tmp_path)
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    with pytest.raises(VerificationError, match="Linux container"):
        OpenAITransport(contract, objects, tmp_path)


def test_invalid_credential_is_not_in_error_or_artifacts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.harness import openai_live
    monkeypatch.setattr(openai_live, "require_live_container", lambda: None)
    monkeypatch.setenv("OPENAI_API_KEY", "private-value\ninvalid")
    objects = CAS(tmp_path)
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    with pytest.raises(VerificationError, match="invalid header characters") as caught:
        OpenAITransport(contract, objects, tmp_path / "transport")
    assert "private-value" not in str(caught.value)
    assert not (tmp_path / "transport").exists()


@pytest.mark.parametrize("count,fail,expected_paid", [(32769, False, 0), (10, True, 1), (10, False, 1)])
def test_transport_counts_before_paid_dispatch_and_never_retries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                               count: int, fail: bool, expected_paid: int) -> None:
    from strive.harness import openai_live
    monkeypatch.setattr(openai_live, "require_live_container", lambda: None)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-must-not-be-retained")
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    paths: list[str] = []
    def post(self: OpenAITransport, path: str, raw: bytes) -> bytes:
        paths.append(path)
        if path.endswith("input_tokens"):
            return canonical({"input_tokens": count, "object": "response.input_tokens"})
        assert self.db.execute("SELECT count(*) FROM calls").fetchone()[0] == 1
        if fail:
            raise VerificationError("simulated lost response")
        return canonical({"id": "receipt"})
    monkeypatch.setattr(OpenAITransport, "_post", post)
    transport = OpenAITransport(contract, objects, tmp_path / "transport")
    request = canonical({**CONTROLS, "model": contract.model, "input": "hello", "max_output_tokens": 1024})
    try:
        if count > 32768 or fail:
            with pytest.raises(VerificationError):
                transport.generate(request, "one")
        else:
            assert transport.generate(request, "one") == b'{"id":"receipt"}'
        if expected_paid:
            with pytest.raises(VerificationError, match="duplicate"):
                transport.generate(request, "one")
        assert paths.count("/v1/responses") == expected_paid
        assert paths[0] == "/v1/responses/input_tokens"
        for path in tmp_path.rglob("*"):
            if path.is_file():
                assert b"test-key-must-not-be-retained" not in path.read_bytes()
    finally:
        transport.close()


def test_native_opencode_inside_linux_jail_without_spending(tmp_path: Path) -> None:
    import sys
    from strive.harness.native_opencode import profile
    if sys.platform != "linux" or shutil.which("opencode") is None:
        pytest.skip("native OpenCode jail qualification runs in the orchestrator container")
    setup = Setup(tmp_path, cap="0.10")
    setup.launch = profile(Path(shutil.which("opencode") or ""))
    setup.manifest.write_text(setup.manifest.read_text().replace('version = "fixture/1"', 'version = "1.18.30"')
                              .replace('deadline_seconds = 10', 'deadline_seconds = 150'))
    try:
        campaign = setup.open(native=True)
        result = campaign.drive()
        assert result["status"] == "finished" and len(setup.calls) == 3
        assert all(gateway.stop_reason(RunId("campaign")) is None for gateway in campaign.gateways.values())
    finally:
        setup.close()


def test_campaign_records_provider_overrun_and_stops_dispatch(tmp_path: Path) -> None:
    setup = Setup(tmp_path, cap="0.10")
    setup.overrun = True
    try:
        campaign = setup.open()
        assert campaign.drive()["budget_stopped"] is True
        state = campaign.reader.verify()
        assert state.dispatch_stopped and len(setup.calls) == 1
        assert amounts(state.effects[-1].overrun)[Resource.USD_NANODOLLARS] == 1200
        campaign.drive()
        assert len(setup.calls) == 1
    finally:
        setup.close()
