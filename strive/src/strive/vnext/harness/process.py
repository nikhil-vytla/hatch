"""M3-style bounded process capture with a local effect-scoped HTTP gateway.

Deno permission isolation is for fixture processes only. No native CLI fallback
is allowed without an implemented OS jail. HTTP is never a general proxy.
"""
from collections.abc import Callable
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
import threading
import time

from ..codec import content_ref, encode
from ..contracts.harness import CapturedStreams, PreparedGeneration, ProcessHandle, ProcessObservations
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..runtime._memory import resident_bytes
from ..runtime.linux_jail import LinuxJail
from .gateway import ModelGateway
from .profiles import LaunchProfile, NATIVE_RESIDUAL, fixture_profile
from .provider import json_object
from .process_identity import birth


class ProcessServices:
    def __init__(self, gateway: ModelGateway, profile: LaunchProfile, scratch_root: Path,
                 forward: Callable[[bytes, Callable[[bytes], bytes]], bytes], *, mode: str = "normal") -> None:
        self.gateway, self.profile, self.scratch_root, self._forward = gateway, profile, scratch_root, forward
        self.mode = mode
        self._process: subprocess.Popen[bytes] | None = None
        self.jail: LinuxJail | None = None
        self._prepared: PreparedGeneration | None = None
        self._token: str | None = None
        self._failure: BaseException | None = None
        self._timer: threading.Timer | None = None
        self._timed_out = False
        self._deadline = 0.0
        self._started = 0.0
        self._temporary: tempfile.TemporaryDirectory[str] | None = None
        self.route = "inherited-pipe"
        self.url = "pipe://effect/generation"

    @property
    def model_gateway(self) -> "ProcessServices":
        return self

    def forward(self, actual_provider_request: ArtifactRef) -> ArtifactRef:
        if self._prepared is None or self._token is None:
            raise VerificationError("gateway capability has not been issued")
        response = self.gateway.dispatch(self._prepared.execution_context, self._token,
            self.gateway.objects.read(actual_provider_request), self._forward)
        return self.gateway.objects.publish(response)

    def launch_confined(self, prepared_generation: PreparedGeneration) -> ProcessHandle:
        if self.profile.fixture_script is None:
            raise VerificationError(NATIVE_RESIDUAL)
        executable_path = shutil.which("deno")
        if executable_path is None:
            raise VerificationError("qualified Deno runtime unavailable")
        safe_profile = fixture_profile(self.profile.backend, Path(executable_path), self.profile.fixture_script)
        if self.profile.executable != safe_profile.executable or self.profile.arguments != safe_profile.arguments:
            raise VerificationError("fixture profile must enforce the qualified Deno permission arguments")
        if prepared_generation.deadline_seconds > self.profile.deadline_seconds:
            raise VerificationError("prepared deadline exceeds launch profile")
        if self._process is not None:
            raise VerificationError("one process per fresh native session")
        executable, config, sandbox = self.profile.references(self.gateway.objects)
        if (executable != prepared_generation.executable_reference or config != prepared_generation.effective_configuration
                or sandbox != prepared_generation.sandbox_profile
                or prepared_generation.launch_arguments != (str(self.profile.executable), *self.profile.arguments)):
            raise VerificationError("changed executable or effective launch profile")
        self._prepared = prepared_generation
        token = self.gateway.issue(prepared_generation)
        self._token = token
        self.scratch_root.mkdir(parents=True, exist_ok=True)
        self._temporary = tempfile.TemporaryDirectory(prefix="harness-", dir=self.scratch_root)
        scratch = Path(self._temporary.name)
        source = self.profile.fixture_script.read_bytes()
        launcher = Path(__file__).parent.parent / "runtime" / "_limits.py"
        command = [sys.executable, "-I", str(launcher), str(prepared_generation.deadline_seconds),
                   str(self.profile.output_limit), *prepared_generation.launch_arguments]
        payload = json.dumps({"url": self.url, "token": token, "backend": self.profile.backend,
                              "protocol": self.gateway.contract.protocol, "model": self.gateway.contract.model,
                              "transport": "pipe", "max_output_tokens": self.gateway.contract.output_ceiling,
                              "input": prepared_generation.input_bytes.decode(), "mode": self.mode}).encode()
        environment = {"DENO_DIR": str(scratch / "cache"), "DENO_NO_UPDATE_CHECK": "1", "NO_COLOR": "1",
                       "TMPDIR": str(scratch), "LANG": "C"}
        launch_record = self.gateway.objects.publish(encode(("process-launch/1", prepared_generation,
            tuple(command), payload, tuple(sorted(environment.items())), content_ref(source),
            self.gateway.objects.publish(launcher.read_bytes()))))
        self.gateway.event(prepared_generation.execution_context, "launch", launch_record)
        self.gateway.fault("launch-retained")
        self._started = time.monotonic()
        self._deadline = self._started + prepared_generation.deadline_seconds
        self.jail = LinuxJail.available()
        if self.jail is not None:
            # Retain the unique cgroup identity before any payload can run.
            self.gateway.event(prepared_generation.execution_context, "os-jail",
                self.gateway.objects.publish(encode(("linux-cgroup/1", str(self.jail.group),
                    Path("/proc/sys/kernel/random/boot_id").read_text().strip(), self.jail.identity))))
        try:
            self._process = (self.jail.launch(command) if self.jail is not None else
                subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=environment, cwd=scratch, close_fds=True, start_new_session=True))
        except BaseException:
            if self.jail is not None:
                self.jail.close()
            raise
        assert self._process.stdin is not None
        self._process.stdin.write(payload + b"\n")
        self._process.stdin.flush()
        def timeout() -> None:
            self._timed_out = True
            assert self._process is not None
            self.cancel(ProcessHandle(prepared_generation.execution_context.effect_id,
                prepared_generation.execution_context.epoch, str(self._process.pid)))
        self._timer = threading.Timer(prepared_generation.deadline_seconds, timeout)
        self._timer.daemon = True
        self._timer.start()
        self.gateway.event(prepared_generation.execution_context, "pid",
                           self.gateway.objects.publish(encode(("process-identity/1", self._process.pid, birth(self._process.pid)))))
        self.gateway.fault("process-started")
        return ProcessHandle(prepared_generation.execution_context.effect_id, prepared_generation.execution_context.epoch,
                             str(self._process.pid))

    def _check(self, handle: ProcessHandle) -> subprocess.Popen[bytes]:
        if self._process is None or self._prepared is None or handle != ProcessHandle(
                self._prepared.execution_context.effect_id, self._prepared.execution_context.epoch, str(self._process.pid)):
            raise VerificationError("stale process handle")
        return self._process

    def enforce_deadline(self, process: ProcessHandle, deadline_seconds: int) -> None:
        self._check(process)
        self._deadline = min(self._deadline, self._started + deadline_seconds)

    def capture_bounded(self, process: ProcessHandle, max_bytes: int) -> CapturedStreams:
        child = self._check(process)
        assert child.stdout is not None and child.stderr is not None
        out, err = bytearray(), bytearray()
        timed_out, truncated = False, False
        pending = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, out)
            selector.register(child.stderr, selectors.EVENT_READ, err)
            while selector.get_map():
                if time.monotonic() >= self._deadline or (self.jail is None and resident_bytes(child.pid) > 256 * 1024 * 1024):
                    timed_out = True
                    break
                for key, _ in selector.select(0.02):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if key.data is out:
                            pending.extend(chunk)
                            while b"\n" in pending:
                                line, _, tail = pending.partition(b"\n")
                                pending = bytearray(tail)
                                self._pipe_request(bytes(line), child)
                        if len(out) + len(err) > min(max_bytes, self.profile.output_limit):
                            truncated = True
                            break
                if truncated:
                    break
        if timed_out or truncated:
            self.cancel(process)
        else:
            try:
                child.wait(timeout=max(0.001, self._deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
                self.cancel(process)
        if self._failure is not None:
            raise self._failure
        return CapturedStreams(self.gateway.objects.publish(bytes(out[:max_bytes])), self.gateway.objects.publish(bytes(err[:max_bytes])),
            ProcessObservations(child.returncode, -child.returncode if child.returncode and child.returncode < 0 else None,
                                timed_out or self._timed_out, False, truncated, math.ceil((time.monotonic() - self._started) * 1000)))

    def _pipe_request(self, line: bytes, child: subprocess.Popen[bytes]) -> None:
        try:
            envelope = json_object(line)
        except VerificationError:
            return  # Native output decoder will classify malformed output.
        if "gateway_request" not in envelope:
            return
        assert self._prepared is not None and child.stdin is not None
        context = self._prepared.execution_context
        try:
            raw, token = envelope.get("gateway_request"), envelope.get("token")
            if envelope.get("path") != "/generation" or not isinstance(raw, str) or not isinstance(token, str):
                raise VerificationError("gateway route only; no auxiliary endpoint")
            body = self.gateway.dispatch(context, token, raw.encode(), self._forward)
            result = {"status": 200, "body": body.decode()}
        except BaseException as error:
            if self._failure is None:
                self._failure = error
            if not isinstance(error, Exception):
                raise
            self.gateway.deny(context)
            result = {"status": 403, "body": "{}"}
        try:
            child.stdin.write(json.dumps(result).encode() + b"\n")
            child.stdin.flush()
        except (BrokenPipeError, ConnectionResetError):
            # A deadline can kill the child while its parent awaits OpenAI.
            # Preserve the upstream cause instead of replacing it with EPIPE.
            if self._failure is not None:
                raise self._failure
            raise

    def cancel(self, process: ProcessHandle) -> None:
        child = self._check(process)
        assert self._prepared is not None
        self.gateway.revoke(self._prepared.execution_context)
        if self.jail is not None:
            self.jail.kill()
        # Reap only our child; the cgroup kill also covers reparented descendants.
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # This host can return EPERM for a group whose last process is
                # already exiting after a recovery kill. Only ignore it after
                # proving our own child has actually exited.
                child.wait(timeout=1)
        child.wait()

    def close(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer.join(timeout=2)
        if self._process is not None and self._prepared is not None:
            context = self._prepared.execution_context
            self.cancel(ProcessHandle(context.effect_id, context.epoch, str(self._process.pid)))
            if self._process.stdin is not None:
                self._process.stdin.close()
            if self._process.stdout is not None:
                self._process.stdout.close()
            if self._process.stderr is not None:
                self._process.stderr.close()
        if self.jail is not None:
            self.jail.close()
            if self._prepared is not None:
                self.gateway.event(self._prepared.execution_context, "os-jail-exit",
                    self.gateway.objects.publish(encode(("linux-cgroup-events/1", tuple(sorted(self.jail.events.items()))))))
        if self._temporary is not None:
            self._temporary.cleanup()
