"""Verification must not depend on kernel import order.

A run is driven by the kernel (which writes command payloads, results, and
fork observations), then a FRESH interpreter that imports ONLY
`strive.substrate` — never `strive.kernel` — must still verify it end to end.
This proves the runtime contracts live in a neutral module the substrate
imports directly.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

from strive.contracts import BudgetSpec
from strive.kernel import KernelServices, run_policy
from strive.policies import manual_change as mc
from strive.policy import default_catalog
from strive.substrate import new_run_id
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


def test_fresh_interpreter_verifies_without_importing_kernel(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    run = new_run_id()
    services = KernelServices.open(root, TASK, run, seed=7, budget=BudgetSpec(executions=128))
    objects = services.substrate.objects
    report = run_policy(
        services, default_catalog(), "manual-change@1",
        mc.load_config(mc.DEFAULT_CONFIG_PATH),
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )
    assert report.stopped_reason == "manual change complete"

    program = textwrap.dedent(
        f"""
        import sys
        from pathlib import Path
        import strive.substrate as S
        # the kernel must NOT be needed for verification
        assert "strive.kernel" not in sys.modules, "kernel was imported"
        sub = S.Substrate.discover(Path({str(root)!r}), {run!r})
        view = sub.verify()
        assert view.ok, view.errors
        # the fork summary + attempts decoded via the neutral runtime module
        assert any(getattr(b, "observation_kind", None) == "fork-evaluation"
                   for b in view.bodies)
        print("OK")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", program], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr[-800:]}"
    assert "OK" in result.stdout
