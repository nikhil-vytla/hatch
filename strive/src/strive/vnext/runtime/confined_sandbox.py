"""CandidateSandbox implementation that adds Linux confinement to frozen M3.

The permission sandbox and its wire protocol stay frozen. Composition roots
select this subclass; on unsupported hosts it retains the M3 launch behavior.
"""
from dataclasses import replace
import os
from pathlib import Path
import selectors
import subprocess
import time

from ..codec import content_ref
from .linux_jail import ENFORCED, LinuxJail, capability
from .sandbox import DenoSandbox as PermissionSandbox, SandboxFailure, SandboxLimits


# Only trusted startup runs before this prefix. Consume it once, so candidate
# output can neither impersonate readiness nor extend the execution deadline.
_READY = b"strive-candidate-ready/1\n"
_STARTUP_SECONDS = 30.0


class DenoSandbox(PermissionSandbox):
    def __init__(self, scratch_root: Path, limits: SandboxLimits = SandboxLimits()) -> None:
        super().__init__(scratch_root, limits)
        detected = capability()
        self.jail_events: dict[str, int] = {}
        self._qualified = detected.available
        if detected.available:
            self._profile = replace(self._profile, name="deno-linux-jail/1",
                runtime=content_ref(Path(__file__).read_bytes()),
                monitor=content_ref(detected.identity),
                enforced=tuple(value for value in self._profile.enforced if value != "rss-watchdog") + ENFORCED,
                deferred=())
        else:
            self._profile = replace(self._profile, deferred=(detected.reason, *self._profile.deferred))

    def _capture(self, command: list[str], payload: bytes, scratch: Path) -> bytes:
        jail = LinuxJail.available(memory_bytes=self.limits.resident_megabytes * 1024 * 1024)
        if jail is None:
            if self._qualified:
                raise SandboxFailure("qualified OS jail disappeared")
            return super()._capture(command, payload, scratch)
        if not self._qualified:
            raise SandboxFailure("OS jail changed after the profile was retained")
        bootstrap = scratch / "bootstrap.js"
        bootstrap.write_bytes(
            b"Deno.stdout.writeSync(new Uint8Array(" + str(list(_READY)).encode("ascii") + b"));\n"
            + bootstrap.read_bytes())
        output, errors = bytearray(), bytearray()
        ready = bytearray()
        started = False
        with jail, (scratch / "input").open("w+b") as stream:
            stream.write(payload)
            stream.seek(0)
            deadline = time.monotonic() + _STARTUP_SECONDS
            child = jail.launch(command, stdin=stream)
            assert child.stdout is not None and child.stderr is not None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ, output)
                    selector.register(child.stderr, selectors.EVENT_READ, errors)
                    while selector.get_map():
                        if time.monotonic() >= deadline:
                            raise SandboxFailure("candidate wall limit exceeded" if started
                                                 else "candidate jail startup limit exceeded")
                        for key, _ in selector.select(min(0.02, max(0.0, deadline - time.monotonic()))):
                            chunk = os.read(key.fd, 8192)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            if key.data is output and not started:
                                needed = len(_READY) - len(ready)
                                ready.extend(chunk[:needed])
                                chunk = chunk[needed:]
                                if not _READY.startswith(ready):
                                    raise SandboxFailure("candidate jail startup failed: invalid ready signal")
                                if len(ready) == len(_READY):
                                    if time.monotonic() >= deadline:
                                        raise SandboxFailure("candidate jail startup limit exceeded")
                                    started = True
                                    deadline = time.monotonic() + self.limits.wall_seconds
                            key.data.extend(chunk)
                            if len(output) + len(errors) > self.limits.output_bytes:
                                raise SandboxFailure("candidate output limit exceeded")
                try:
                    code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired as error:
                    raise SandboxFailure("candidate wall limit exceeded" if started
                                         else "candidate jail startup limit exceeded") from error
                if jail.read_events().get("memory.events.oom_kill", 0):
                    raise SandboxFailure("candidate cgroup memory limit exceeded (OOM killed)")
                if code:
                    raise SandboxFailure("candidate failed: " + errors[:1024].decode(errors="replace"))
                if not started:
                    raise SandboxFailure("candidate jail startup failed: missing ready signal")
            finally:
                try:
                    jail.close()
                finally:
                    self.jail_events = dict(jail.events)
                    child.stdout.close()
                    child.stderr.close()
        return bytes(output)
