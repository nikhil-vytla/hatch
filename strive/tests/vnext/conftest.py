"""M5 adapters are installed in separate environments; fixtures use their light API."""
from pathlib import Path
import socket
import sys
from collections.abc import Iterator
import ipaddress

import pytest

ROOT = Path(__file__).resolve().parents[2]
for source in (ROOT / "adapters/tau2/src", ROOT / "adapters/counter/src"):
    sys.path.insert(0, str(source))


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Allow existing M4 loopback gateway fixtures, reject external test traffic."""
    original = socket.socket.connect
    def connect(sock: socket.socket, address: tuple[str, int] | str) -> None:
        if isinstance(address, tuple):
            try:
                permitted = ipaddress.ip_address(address[0]).is_loopback
            except ValueError:
                permitted = address[0] == "localhost"
            if not permitted:
                raise AssertionError("external network disabled in deterministic vNext tests")
        original(sock, address)
    monkeypatch.setattr(socket.socket, "connect", connect)
    yield
