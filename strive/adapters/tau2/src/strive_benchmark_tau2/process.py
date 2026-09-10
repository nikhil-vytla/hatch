"""Only bytes cross into the separately installed tau2 interpreter."""
from pathlib import Path
import subprocess

from strive.vnext.benchmarks.closure import verify_closure
from strive.vnext.benchmarks.json_data import canonical, obj, parse
from strive.vnext.codec import encode
from strive.vnext.contracts.primitives import ArtifactRef
from strive.vnext.errors import VerificationError
from strive.vnext.store.cas import CAS
from .data import verify_data


class IsolatedTau2:
    def __init__(self, python: Path, data_root: Path, objects: CAS, closure: ArtifactRef, data_index: ArtifactRef) -> None:
        verify_closure(objects, closure)
        self.python, self.data_root, self.objects, self.closure = python.absolute(), data_root.resolve(), objects, closure
        self.data_index = data_index
        verify_data(objects, data_index, self.data_root)
        self.script = Path(__file__).with_name("native_worker.py")
        self.identity = objects.publish(encode(("isolated-tau2-worker/1", closure, data_index,
            objects.publish(self.script.read_bytes()), objects.publish(Path(__file__).read_bytes()))))

    def call(self, operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]:
        verify_closure(self.objects, self.closure)
        verify_data(self.objects, self.data_index, self.data_root)
        request = canonical({"operation": operation, "state": parse(state) if state else None, "payload": parse(payload)})
        result = subprocess.run([str(self.python), "-I", "-B", str(self.script)], input=request,
            capture_output=True, timeout=60, cwd=self.data_root,
            env={"TAU2_DATA_DIR": str(self.data_root), "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
            raise VerificationError("isolated tau2 worker failed: " + result.stderr[-4000:].decode(errors="replace"))
        response = obj(parse(result.stdout))
        if set(response) != {"state", "output"}:
            raise VerificationError("malformed isolated tau2 response")
        return canonical(response["state"]), canonical(response["output"])
