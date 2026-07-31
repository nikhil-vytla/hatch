"""Generate counterfactual capture-policy recipes for Click.

The public repository supplies the real implementation context. Each recipe
adds a mode that never existed upstream, then withholds a different subset of
the cross-cutting implementation. Hidden checks exercise behavior, not a gold
diff or private helper name.
"""

from __future__ import annotations

import json
from pathlib import Path

REVISION = "00e592cea702e0b2caa0dee42489fdb1c22cd845"
MODES = (
    "portable",
    "adaptive",
    "native_safe",
    "platform_auto",
    "host_capture",
    "fd_preferred",
    "cross_platform",
    "runtime_native",
    "best_available",
    "system_adaptive",
    "native_or_sys",
    "portable_fd",
)

ALIAS_BEFORE = '''if sys.platform == "win32":
    CaptureMode: t.TypeAlias = t.Literal["sys"]  # pyright: ignore[reportRedeclaration]
else:
    CaptureMode: t.TypeAlias = t.Literal["sys", "fd"]  # pyright: ignore[reportRedeclaration]
'''

VALIDATION_BEFORE = '''        if capture not in {"sys", "fd"}:
            raise ValueError(
                f"capture={capture!r} is not valid. Choose from 'sys' or 'fd'."
            )
'''

ASSIGNMENT_BEFORE = '''        self.catch_exceptions = catch_exceptions
        self.capture = capture

    def get_default_prog_name(self, cli: Command) -> str:
'''

INVOKE_BEFORE = '''        if self.capture == "fd":
            cap_out = _FDCapture(1)
'''


def build(mode: str, index: int) -> dict[str, object]:
    display = mode.replace("_", "-")
    posix_alias = (
        f'    CaptureMode: t.TypeAlias = t.Literal["sys", "fd", "{mode}"]'
        "  # pyright: ignore[reportRedeclaration]"
    )
    alias_after = f'''if sys.platform == "win32":
    CaptureMode: t.TypeAlias = t.Literal["sys", "{mode}"]  # pyright: ignore[reportRedeclaration]
else:
{posix_alias}
'''
    validation_after = f'''        if capture not in {{"sys", "fd", "{mode}"}}:
            raise ValueError(
                f"capture={{capture!r}} is not valid. "
                "Choose from 'sys', 'fd', or '{mode}'."
            )
'''
    assignment_after = f'''        self.catch_exceptions = catch_exceptions
        self.capture = capture

    def _effective_capture(self) -> t.Literal["sys", "fd"]:
        if self.capture == "{mode}":
            return "sys" if sys.platform == "win32" else "fd"
        return self.capture

    def get_default_prog_name(self, cli: Command) -> str:
'''
    invoke_after = '''        if self._effective_capture() == "fd":
            cap_out = _FDCapture(1)
'''
    contract = f'''import os
import click
from click.testing import CliRunner

@click.command()
def command():
    os.write(1, b"native-stdout\\n")
    os.write(2, b"native-stderr\\n")
    click.echo("python-stdout")
    click.echo("python-stderr", err=True)

runner = CliRunner(capture="{mode}")
result = runner.invoke(command)
assert result.exit_code == 0, result.exception
assert result.stdout == "python-stdout\\nnative-stdout\\n", repr(result.stdout)
assert result.stderr == "python-stderr\\nnative-stderr\\n", repr(result.stderr)
assert result.output == (
    "python-stdout\\npython-stderr\\nnative-stdout\\nnative-stderr\\n"
), repr(result.output)
'''
    regression = '''import click
from click.testing import CliRunner

@click.command()
def command():
    click.echo("out")
    click.echo("err", err=True)

for mode in ("sys", "fd"):
    result = CliRunner(capture=mode).invoke(command)
    assert result.exit_code == 0
    assert result.stdout == "out\\n"
    assert result.stderr == "err\\n"
'''
    invalid = f'''from click.testing import CliRunner

try:
    CliRunner(capture="{mode}-almost")
except ValueError:
    pass
else:
    raise AssertionError("near-match mode must not be accepted")
'''
    omission_sets = (
        ["accept-mode", "resolve-mode", "use-mode"],
        ["resolve-mode", "use-mode"],
        ["use-mode"],
    )
    return {
        "name": f"click-{display}-capture-{index:02d}",
        "source": {
            "locator": "https://github.com/pallets/click.git",
            "revision": REVISION,
            "license": "BSD-3-Clause",
        },
        "prompt": (
            f"Complete Click's new `capture=\"{mode}\"` policy for `CliRunner`. "
            "It must use file-descriptor capture on POSIX so subprocess and native "
            "writes are collected, fall back to `sys` capture on Windows, preserve "
            "the ordering and separation of stdout/stderr, keep explicit `sys` and "
            "`fd` behavior unchanged, and reject unknown values. The type alias has "
            "already been started. Make the smallest coherent implementation and "
            "run focused tests."
        ),
        "implementation_edits": [
            {
                "id": "declare-mode",
                "path": "src/click/testing.py",
                "before": ALIAS_BEFORE,
                "after": alias_after,
            },
            {
                "id": "accept-mode",
                "path": "src/click/testing.py",
                "before": VALIDATION_BEFORE,
                "after": validation_after,
            },
            {
                "id": "resolve-mode",
                "path": "src/click/testing.py",
                "before": ASSIGNMENT_BEFORE,
                "after": assignment_after,
            },
            {
                "id": "use-mode",
                "path": "src/click/testing.py",
                "before": INVOKE_BEFORE,
                "after": invoke_after,
            },
        ],
        "starter_omissions": omission_sets[index % len(omission_sets)],
        "probe_edits": [],
        "checks": [
            {
                "name": "existing-capture-regression",
                "argv": ["python", "-c", regression],
                "weight": 0.2,
                "category": "regression",
                "env": {"PYTHONPATH": "src"},
            },
            {
                "name": "counterfactual-native-capture",
                "argv": ["python", "-c", contract],
                "weight": 0.6,
                "category": "counterfactual",
                "env": {"PYTHONPATH": "src"},
            },
            {
                "name": "near-match-rejected",
                "argv": ["python", "-c", invalid],
                "weight": 0.2,
                "category": "adversarial",
                "env": {"PYTHONPATH": "src"},
            },
        ],
        "allowed_paths": ["src/click/testing.py", "tests/test_testing.py"],
        "behavior_tags": [
            "repository-grounding",
            "scope-control",
            "focused-verification",
            "fresh-verification",
        ],
    }


def main() -> None:
    target = Path(__file__).with_name("click")
    target.mkdir(exist_ok=True)
    for index, mode in enumerate(MODES):
        path = target / f"{index:02d}-{mode}.json"
        path.write_text(json.dumps(build(mode, index), indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
