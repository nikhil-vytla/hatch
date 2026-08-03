from __future__ import annotations

import json
from pathlib import Path

from .canonical import atomic_write
from .swebench import SweScriptFamily
from .types import StrictModel

HUD_VERSION = "0.6.12"
ENVIRONMENT_SOURCE = b"from swebench_runtime import env\n"


class EnvironmentBundle(StrictModel):
    instance_json: bytes
    env_py: bytes
    runtime_py: bytes
    dockerfile: bytes

    def write(self, directory: Path) -> None:
        atomic_write(directory / "instance.json", self.instance_json)
        atomic_write(directory / "env.py", self.env_py)
        atomic_write(directory / "swebench_runtime.py", self.runtime_py)
        atomic_write(directory / "Dockerfile.hud", self.dockerfile)


def render_environment(family: SweScriptFamily) -> EnvironmentBundle:
    problem = family.static.problem
    verifier = problem.verifier
    instance = {
        "environment_name": f"parallax-{problem.instance_id}",
        "source": {
            "base_commit": problem.base_commit,
            "dataset": problem.dataset,
            "dataset_revision": problem.dataset_revision,
            "instance_id": problem.instance_id,
            "problem_statement": problem.problem_statement,
            "public_digest": problem.public_digest,
            "repo": problem.repo,
            "version": problem.version,
        },
        "scripts": {
            script.arm: {
                "agent_steps": script.agent_steps,
                "max_output_tokens": script.max_output_tokens,
                "turns": tuple(turn.text for turn in script.turns),
            }
            for script in family.scripts
        },
        "version": "0.3.0",
    }
    instance_json = (
        json.dumps(
            instance,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
        + b"\n"
    )
    dockerfile = (
        "FROM --platform=linux/amd64 "
        f"{verifier.image_ref}@sha256:{verifier.image_digest}\n\n"
        "RUN python -m venv /opt/hud-venv && "
        "/opt/hud-venv/bin/python -m pip install --no-cache-dir "
        f'"hud=={HUD_VERSION}" && '
        "(command -v bwrap >/dev/null || "
        "(apt-get update && apt-get install -y --no-install-recommends "
        "bubblewrap util-linux && rm -rf /var/lib/apt/lists/*))\n\n"
        "RUN chown -R 1000:1000 /testbed\n\n"
        "WORKDIR /app\n"
        "COPY env.py instance.json swebench_runtime.py /app/\n\n"
        "EXPOSE 8765\n"
        'CMD ["/opt/hud-venv/bin/hud", "serve", "env.py", '
        '"--host", "0.0.0.0", "--port", "8765"]\n'
    ).encode()
    runtime_path = Path(__file__).with_name("swebench_runtime.py")
    return EnvironmentBundle(
        instance_json=instance_json,
        env_py=ENVIRONMENT_SOURCE,
        runtime_py=runtime_path.read_bytes(),
        dockerfile=dockerfile,
    )
