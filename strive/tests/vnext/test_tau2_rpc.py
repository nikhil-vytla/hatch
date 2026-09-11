"""Real subprocess round trip using a synthetic backend, with tau2 import denied."""
from pathlib import Path
import subprocess
import sys
from typing import Any

import pytest

from strive.vnext.benchmarks.api import BenchmarkAdapter
from strive_benchmark_tau2.client import Tau2Client
from .benchmark_fixtures import BenchmarkFixture

ROOT = Path(__file__).resolve().parents[2]


def test_adapter_rpc_keeps_implementation_and_store_in_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = BenchmarkFixture(tmp_path / "run")
    script = tmp_path / "fixture_server.py"
    script.write_text(f'''
import sys
import importlib.abc
sys.path[:0] = {[str(ROOT / 'src'), str(ROOT / 'adapters/tau2/src'), str(ROOT / 'tests')]!r}
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {{'tau2', 'dspy', 'litellm', 'openai', 'pydantic'}}:
            raise AssertionError('fixture must not import live tau2: ' + fullname)
sys.meta_path.insert(0, Guard())
from strive.vnext.contracts.primitives import ArtifactRef
from vnext.benchmark_fixtures import SyntheticTelecom
from strive_benchmark_tau2 import server
server.IsolatedTau2 = lambda *args: SyntheticTelecom(ArtifactRef({fixture.pin.digest!r}))
server.main()
''')
    original = subprocess.run
    def transport(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        assert command[-2:] == ["-m", "strive_benchmark_tau2.server"]
        return original([sys.executable, "-I", "-B", str(script)], **kwargs)
    monkeypatch.setattr(subprocess, "run", transport)
    config = (str(fixture.store.objects.directory), str(fixture.root / "operations"), str(fixture.scope.run_id),
              fixture.writer.epoch, fixture.pin, fixture.pin, fixture.adapter.qualification.report)
    try:
        client = Tau2Client(Path(sys.executable), tmp_path, config, fixture.adapter.identity)
        protocol: BenchmarkAdapter = client
        assert protocol.describe() == fixture.adapter.describe()
        assert protocol.enumerate_tasks() == fixture.adapter.enumerate_tasks()
        assert protocol.declare_splits() == fixture.adapter.declare_splits()
        fixture.bridge.adapter = client
        fixture.driver.adapter = client
        fixture.initialize()
        fixture.tool("agent"); fixture.driver.consume()
        fixture.tool("user"); fixture.driver.consume()
        fixture.terminate()
        assert fixture.driver.score().metrics[0].value == 1
    finally:
        fixture.close()


def test_client_preserves_virtualenv_interpreter_symlink(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.vnext.benchmarks.api import BenchmarkDescriptor
    from strive.vnext.codec import content_ref
    pin = content_ref(b"interpreter path regression fixture")
    descriptor = BenchmarkDescriptor("strive.benchmark/1", pin, pin, "fixture", pin, pin, (), True, False)
    def describe(self: Tau2Client, *args: object) -> BenchmarkDescriptor:
        return descriptor
    monkeypatch.setattr(Tau2Client, "call", describe)
    python = tmp_path / "venv/bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    client = Tau2Client(python, tmp_path, (), pin)
    assert client.python == python.absolute()
    assert client.python != python.resolve()
