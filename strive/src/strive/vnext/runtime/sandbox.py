"""Deno candidate confinement with explicit, host-verifiable limits.

ECMAScript step(view, private_state, recorded_result, handles) uses M2 tagged
JSON for the frozen contract values and returns a tagged StepOutput. handles
maps authorized content digests to base64 bytes. No CAS/path handle crosses.
A new backend can implement CandidateSandbox without changing the supervisor.
"""

from dataclasses import dataclass, replace
import base64
import json
import math
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Mapping, Protocol

from ..codec import content_ref, decode, encode
from ..contracts.commands import AuthorizedView, RecordedResult, StepOutput
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ._memory import resident_bytes


@dataclass(frozen=True)
class ConfinementProfile:
    name: str
    executable: ArtifactRef
    bootstrap: ArtifactRef
    launcher: ArtifactRef
    runtime: ArtifactRef
    monitor: ArtifactRef
    configuration: tuple[tuple[str, int], ...]
    enforced: tuple[str, ...]
    deferred: tuple[str, ...]

    def to_bytes(self) -> bytes:
        return encode((self.name, self.executable, self.bootstrap, self.launcher, self.runtime,
                       self.monitor, self.configuration, self.enforced, self.deferred))

    @property
    def production_floor(self) -> bool:
        return not self.deferred


@dataclass(frozen=True)
class SandboxLimits:
    cpu_seconds: int = 2
    wall_seconds: float = 3.0
    heap_megabytes: int = 64
    resident_megabytes: int = 256
    output_bytes: int = 128 * 1024
    input_bytes: int = 1024 * 1024

    def __post_init__(self) -> None:
        for value in (self.cpu_seconds, self.heap_megabytes, self.resident_megabytes, self.output_bytes, self.input_bytes):
            if type(value) is not int or value <= 0:
                raise ValueError("sandbox limits must be positive integers")
        if not math.isfinite(self.wall_seconds) or self.wall_seconds <= 0:
            raise ValueError("wall limit must be finite and positive")


class SandboxFailure(RuntimeError):
    pass


class CandidateSandbox(Protocol):
    @property
    def wall_limit_milliseconds(self) -> int: ...
    def profile(self) -> ConfinementProfile: ...
    def run(self, source: bytes, view: AuthorizedView, private_state: bytes,
            result: RecordedResult | None, inputs: Mapping[ArtifactRef, bytes]) -> StepOutput: ...


class DenoSandbox:
    def __init__(self, scratch_root: Path, limits: SandboxLimits = SandboxLimits()) -> None:
        executable = shutil.which("deno")
        if executable is None:
            raise SandboxFailure("Deno required; no unsafe CPython fallback")
        self.executable = Path(executable).resolve()
        self.scratch_root = scratch_root.resolve()
        self.scratch_root.mkdir(parents=True, exist_ok=True)
        self.limits = limits
        self._bootstrap = Path(__file__).with_name("_candidate.js")
        self._launcher = Path(__file__).with_name("_limits.py")
        self._profile = ConfinementProfile(
            "deno-permissions/1", content_ref(self.executable.read_bytes()),
            content_ref(self._bootstrap.read_bytes()), content_ref(self._launcher.read_bytes()),
            content_ref(Path(__file__).read_bytes()), content_ref(Path(__file__).with_name("_memory.py").read_bytes()), (),
            ("no-host-files", "no-network", "no-env", "no-subprocess", "no-ffi",
             "runtime-import-checks", "closed-fds", "fresh-cwd", "cpu-rlimit",
             "file-size-rlimit", "fd-rlimit", "wall-watchdog", "output-cap", "v8-heap-cap", "rss-watchdog"),
            ("hard whole-process memory limit: cgroup/VM or tested OS jail required",
             "aggregate storage quota and OS process-tree jail: Seatbelt or container/VM required"))

    @property
    def wall_limit_milliseconds(self) -> int:
        return math.ceil(self.limits.wall_seconds * 1000)

    def profile(self) -> ConfinementProfile:
        limits = self.limits
        return replace(self._profile, configuration=(("wall_milliseconds", self.wall_limit_milliseconds),
                       ("cpu_seconds", limits.cpu_seconds), ("heap_megabytes", limits.heap_megabytes),
                       ("resident_megabytes", limits.resident_megabytes), ("output_bytes", limits.output_bytes),
                       ("input_bytes", limits.input_bytes)))

    def run(self, source: bytes, view: AuthorizedView, private_state: bytes,
            result: RecordedResult | None, inputs: Mapping[ArtifactRef, bytes]) -> StepOutput:
        allowed = {item.reference for item in view.artifacts}
        if result is not None:
            allowed.add(result.output.reference)
        scopes = {item.access_scope for item in view.artifacts}
        if result is not None:
            scopes.add(result.output.access_scope)
        if len(scopes) > 1 or set(inputs) != allowed or any(content_ref(data) != ref for ref, data in inputs.items()):
            raise VerificationError("sandbox inputs differ from scoped handles")
        if (content_ref(self.executable.read_bytes()) != self._profile.executable
                or content_ref(self._bootstrap.read_bytes()) != self._profile.bootstrap
                or content_ref(self._launcher.read_bytes()) != self._profile.launcher):
            raise SandboxFailure("confinement executable changed")
        if len(source) + len(private_state) + sum(map(len, inputs.values())) > self.limits.input_bytes:
            raise SandboxFailure("candidate input limit exceeded")
        payload = json.dumps({"source": source.decode("utf-8"), "view": json.loads(encode(view)),
                              "state": json.loads(encode(private_state)), "result": json.loads(encode(result)),
                              "handles": {ref.digest: base64.b64encode(data).decode("ascii") for ref, data in inputs.items()}}).encode()
        if len(payload) > self.limits.input_bytes:
            raise SandboxFailure("candidate input limit exceeded")
        with tempfile.TemporaryDirectory(prefix="candidate-", dir=self.scratch_root) as folder:
            scratch = Path(folder)
            bootstrap = scratch / "bootstrap.js"
            bootstrap.write_bytes(self._bootstrap.read_bytes())
            # Source is delivered over stdin, never loaded as a Deno module.
            command = [sys.executable, "-I", str(self._launcher), str(self.limits.cpu_seconds),
                       str(self.limits.output_bytes), str(self.executable), "run", "--quiet", "--no-prompt",
                       "--no-config", "--no-lock", "--no-npm", "--cached-only", "--no-code-cache",
                       "--deny-read", "--deny-write", "--deny-net", "--deny-env", "--deny-run", "--deny-ffi",
                       "--deny-sys", "--deny-import", f"--v8-flags=--max-old-space-size={self.limits.heap_megabytes}", str(bootstrap)]
            output = self._capture(command, payload, scratch)
        try:
            # Canonicalize JSON transport, then validate all frozen contract types.
            value = decode(json.dumps(json.loads(output), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode())
        except (ValueError, VerificationError, RecursionError) as error:
            raise SandboxFailure("malformed candidate output") from error
        if not isinstance(value, StepOutput):
            raise SandboxFailure("candidate did not return StepOutput")
        return value

    def _capture(self, command: list[str], payload: bytes, scratch: Path) -> bytes:
        environment = {"DENO_DIR": str(scratch / "cache"), "DENO_NO_UPDATE_CHECK": "1", "NO_COLOR": "1",
                       "TMPDIR": str(scratch), "LANG": "C"}
        # A regular input file avoids deadlock when a hostile step stops reading.
        with (scratch / "input").open("w+b") as stream:
            stream.write(payload)
            stream.seek(0)
            process = subprocess.Popen(command, stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       cwd=scratch, env=environment, close_fds=True, start_new_session=True)
            assert process.stdout is not None and process.stderr is not None
            output, error = bytearray(), bytearray()
            deadline = time.monotonic() + self.limits.wall_seconds
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ, output)
                    selector.register(process.stderr, selectors.EVENT_READ, error)
                    while selector.get_map():
                        if time.monotonic() >= deadline:
                            raise SandboxFailure("candidate wall limit exceeded")
                        # RSS watchdog is intentionally not advertised as a hard
                        # allocation bound. The OS jail production test stays xfail.
                        rss = resident_bytes(process.pid)
                        if rss > self.limits.resident_megabytes * 1024 * 1024:
                            raise SandboxFailure("candidate resident memory limit exceeded")
                        for key, _ in selector.select(timeout=0.02):
                            chunk = os.read(key.fd, 8192)
                            if chunk:
                                key.data.extend(chunk)
                                if len(output) + len(error) > self.limits.output_bytes:
                                    raise SandboxFailure("candidate output limit exceeded")
                            else:
                                selector.unregister(key.fileobj)
                    remaining = max(0.001, deadline - time.monotonic())
                    try:
                        returncode = process.wait(timeout=remaining)
                    except subprocess.TimeoutExpired as error_timeout:
                        raise SandboxFailure("candidate wall limit exceeded") from error_timeout
                    if returncode != 0:
                        raise SandboxFailure(f"candidate failed: {bytes(error[:1024]).decode('utf-8', 'replace')}")
            finally:
                # Terminate the session even if the entry process has exited.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                process.stdout.close()
                process.stderr.close()
        return bytes(output)
