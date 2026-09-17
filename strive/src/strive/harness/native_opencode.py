"""Native OpenCode over inherited pipes in the existing mandatory Linux jail."""
from collections.abc import Callable
from pathlib import Path
import json
import subprocess
import sys
import threading
import time

from ..codec import encode
from ..contracts.harness import PreparedGeneration, ProcessHandle
from ..errors import VerificationError
from ..runtime.linux_jail import LinuxJail, require_capability
from .adapters.opencode import OpenCodeAdapter
from .bridge import HarnessEffectAdapter
from .openai_live import canonical
from .process import ProcessServices
from .process_identity import birth
from .profiles import LaunchProfile
from .provider import json_object

VERSION = "1.18.30"
HERE = Path(__file__).parent


def profile(executable: Path, deadline: int = 150) -> LaunchProfile:
    detected = require_capability()
    result = subprocess.run([str(executable), "--version"], capture_output=True, timeout=15,
                            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent"})
    if result.returncode or result.stdout.strip() != VERSION.encode():
        raise VerificationError("native OpenCode version must be " + VERSION)
    sources = tuple((name, (HERE / name).read_bytes()) for name in ("opencode_launcher.py", "opencode_pipe.mjs"))
    return LaunchProfile("opencode", VERSION, executable.resolve(), (), encode(("opencode-pipe/1", sources)),
                         encode(("native-opencode-linux-jail/1", detected.identity)), deadline_seconds=deadline)


class TelecomOpenCodeAdapter(OpenCodeAdapter):
    output_schema = b"telecom-action-json/1"

    def native_identifier(self) -> str:
        return "strive/" + self.provider.model

    def decode_text(self, text: str) -> bytes:
        value = json_object(text.encode())
        if set(value) == {"message"} and isinstance(value["message"], str):
            return canonical(value)
        if set(value) == {"tool", "arguments"} and isinstance(value["tool"], str) and isinstance(value["arguments"], dict):
            return canonical(value)
        if value == {"stop": True}:
            return canonical(value)
        raise VerificationError("actor must return one telecom message, tool proposal or stop")


class NativeServices(ProcessServices):
    def launch_confined(self, prepared_generation: PreparedGeneration) -> ProcessHandle:
        require_capability()
        if self._process is not None or self.profile.fixture_script is not None:
            raise VerificationError("fresh native launch required")
        expected = profile(self.profile.executable, self.profile.deadline_seconds)
        if expected != self.profile or prepared_generation.deadline_seconds > self.profile.deadline_seconds:
            raise VerificationError("native launch closure changed")
        executable, config, sandbox = self.profile.references(self.gateway.objects)
        if (executable != prepared_generation.executable_reference or config != prepared_generation.effective_configuration
                or sandbox != prepared_generation.sandbox_profile):
            raise VerificationError("native preparation differs from retained profile")
        self._prepared = prepared_generation
        self._token = self.gateway.issue(prepared_generation)
        payload = canonical({"token": self._token, "input": prepared_generation.input_bytes.decode(),
                             "max_output_tokens": self.gateway.contract.output_ceiling})
        command = [sys.executable, "-I", "-B", str(HERE / "opencode_launcher.py"),
                   str(self.profile.executable), str(HERE / "opencode_pipe.mjs")]
        self.jail = LinuxJail.available(memory_bytes=768 * 1024 * 1024)
        if self.jail is None:
            raise VerificationError("native OpenCode requires Linux jail; no fallback")
        context = prepared_generation.execution_context
        self.gateway.event(context, "os-jail", self.gateway.objects.publish(encode(("linux-cgroup/1", str(self.jail.group),
            Path("/proc/sys/kernel/random/boot_id").read_text().strip(), self.jail.identity))))
        self.gateway.event(context, "launch", self.gateway.objects.publish(encode(("native-opencode-launch/1", prepared_generation, tuple(command)))))
        self._started = time.monotonic()
        self._deadline = self._started + prepared_generation.deadline_seconds
        self._process = self.jail.launch(command)
        assert self._process.stdin is not None
        self._process.stdin.write(payload + b"\n")
        self._process.stdin.flush()
        handle = ProcessHandle(context.effect_id, context.epoch, str(self._process.pid))
        self.gateway.event(context, "pid", self.gateway.objects.publish(encode(("process-identity/1", self._process.pid, birth(self._process.pid)))))
        def timeout() -> None:
            self._timed_out = True
            self.cancel(handle)
        self._timer = threading.Timer(prepared_generation.deadline_seconds, timeout)
        self._timer.daemon = True
        self._timer.start()
        return handle


class NativeOpenCodeBridge(HarnessEffectAdapter):
    def services(self, forward: Callable[[bytes, Callable[[bytes], bytes]], bytes]) -> ProcessServices:
        return NativeServices(self.gateway, self.adapter.profile, self.scratch_root, forward)
