from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from parallax.models import Check

_ENV_ALLOWLIST = (
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
)


def run_check(root: Path, check: Check) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="parallax-check-home-") as home:
        env = {name: os.environ[name] for name in _ENV_ALLOWLIST if name in os.environ}
        env.update(check.env)
        env["HOME"] = home
        try:
            completed = subprocess.run(
                check.argv,
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=check.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            return {
                "name": check.name,
                "category": check.category.value,
                "passed": False,
                "returncode": None,
                "stdout": (error.stdout or "")[-4000:],
                "stderr": (error.stderr or "")[-4000:],
                "timeout": True,
            }
        except OSError as error:
            return {
                "name": check.name,
                "category": check.category.value,
                "passed": False,
                "returncode": None,
                "stdout": "",
                "stderr": str(error),
                "infrastructure_error": True,
            }

    marker_emitted = check.success_marker in completed.stdout.splitlines()
    return {
        "name": check.name,
        "category": check.category.value,
        "passed": completed.returncode == 0 and marker_emitted,
        "marker_emitted": marker_emitted,
        "returncode": completed.returncode,
        "stdout": completed.stdout[-4000:],
        "stderr": completed.stderr[-4000:],
    }
