"""Reproduce transport diagnostics with scripted sockets. No network or spend."""
import errno
import json
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
for source in (ROOT / "tests", ROOT / "adapters/tau2/src", ROOT / "adapters/counter/src"):
    sys.path.insert(0, str(source))

import pytest
from strive.vnext.errors import VerificationError
from strive.vnext.harness import openai_live
from strive.vnext.store.cas import CAS
from strive.vnext.harness.openai_live import CONTROLS, OpenAITransport, canonical, load_contract
from vnext.test_live_campaign import PRICE
from vnext.test_openai_live_transport import KEY, PROMPT, Step, Wire, diagnostic, install_wire


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="strive-scripted-egress-") as temp, pytest.MonkeyPatch.context() as patch:
        root = Path(temp)
        wire = Wire(steps=[Step(), Step(phase="connect", error=OSError(errno.ENETUNREACH,
            "scripted upstream route unavailable"))])
        install_wire(patch, wire, clock=False)
        namespace = threading.local()
        patch.setattr(openai_live, "network_namespace", lambda: getattr(namespace, "name", "net:[egress]"))
        objects = CAS(root / "cas")
        objects.directory.mkdir()
        contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
        transport = OpenAITransport(contract, objects, root / "transport")
        try:
            namespace.name = "net:[gateway-only]"
            request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
            try:
                transport.generate(request, "scripted-egress-proof")
            except VerificationError:
                pass
            else:
                raise AssertionError("scripted transport must fail")
            detail = diagnostic(transport)
            assert detail["errno"] == errno.ENETUNREACH
            assert detail["caller_netns"] == "net:[gateway-only]"
            assert detail["netns"] == "net:[egress]"
            assert wire.namespaces == ["net:[egress]", "net:[egress]"]
            assert wire.threads == [transport._worker.ident, transport._worker.ident]
            assert namespace.name == "net:[gateway-only]"
            encoded = json.dumps({"live": False, "http_attempts": len(wire.connections), "diagnostic": detail}, indent=2)
            assert KEY not in encoded and PROMPT not in encoded
            Path(__file__).with_name("scripted-diagnostic.json").write_text(encoded + "\n")
            print("No-spend egress proof passed; wrote scripted-diagnostic.json")
        finally:
            transport.close()


if __name__ == "__main__":
    main()
