import ast
from pathlib import Path

import pytest

from strive import codec
from strive.contracts.records import CausalIdentity, ProducerKind
from strive.benchmarks.api import BenchmarkDescriptor
from .benchmark_fixtures import BenchmarkFixture
from .fresh_probe import fresh_replay
from .install_adapter import install_light_adapter

ROOT = Path(__file__).resolve().parents[2]


def test_static_verifier_import_boundary_and_unchanged_codec_registry() -> None:
    sources = ROOT / "src/strive"
    files = [*sources.joinpath("verify").glob("*.py"), *sources.joinpath("contracts").glob("*.py"), sources / "codec.py",
             sources / "__init__.py"]
    forbidden = {"tau2", "strive_benchmark_tau2", "strive_benchmark_counter", "benchmarks", "runtime", "harness", "dspy", "litellm", "openai", "pydantic"}
    for path in files:
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                assert not any(set(name.name.split(".")) & forbidden for name in node.names), path
            if isinstance(node, ast.ImportFrom) and node.module:
                # contracts.harness is a frozen lightweight schema module.
                module = node.module.replace("contracts.harness", "contracts")
                if path.parent.name == "contracts" and node.level == 1 and module == "harness":
                    module = "contracts"
                assert not set(module.split(".")) & forbidden, path
                for alias in node.names:
                    resolved = module + "." + alias.name
                    resolved = resolved.replace("contracts.harness", "contracts")
                    assert not set(resolved.split(".")) & forbidden, path
    assert BenchmarkDescriptor not in codec._TYPES.values()
    assert tuple(module.__name__.rsplit(".", 1)[-1] for module in codec._MODULES) == (
        "annotations", "bindings", "commands", "feedback", "harness", "lifecycle", "manifest", "primitives", "records")


@pytest.mark.parametrize("installed", [False, True])
@pytest.mark.parametrize("corruption", ["state", "receipt"])
def test_completed_benchmark_replays_without_adapter_imports(tmp_path: Path, installed: bool, corruption: str) -> None:
    fixture = BenchmarkFixture(tmp_path / "run")
    try:
        fixture.initialize()
        fixture.tool("agent"); fixture.driver.consume()
        fixture.tool("user"); fixture.driver.consume()
        fixture.terminate()
        fixture.driver.score()
        fixture.writer.port(ProducerKind.CANDIDATE).append(codec.opaque_annotation("benchmark.opaque", b"\xffnot JSON: import tau2.candidate"),
            causal=CausalIdentity(fixture.supervisor.state.records[-1].envelope.record_id, None, None, None), epoch=fixture.writer.epoch)
        target = tmp_path / "installed" if installed else None
        if target is not None:
            install_light_adapter(ROOT / "adapters/tau2", target, tmp_path)
        fresh_replay(fixture.root / "artifacts", corrupt=False, benchmark=True, installed=target)
        measurement = fixture.reader.verify().measurements[-1]
        reference = (measurement.supporting_state_references if corruption == "state" else measurement.supporting_receipt_references)[0]
        fixture.store.objects.path(reference).write_bytes(b"corrupt benchmark state")
        fresh_replay(fixture.root / "artifacts", corrupt=True, benchmark=True, installed=target)
    finally:
        fixture.close()
