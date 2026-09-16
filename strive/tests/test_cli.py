"""strive CLI smoke tests: the installed entry point delegates to vNext."""

import subprocess
import sys

import pytest

from strive.cli import main


def test_cli_no_command_is_a_clean_argparse_error() -> None:
    with pytest.raises(SystemExit) as excinfo:
        main([])
    assert excinfo.value.code == 2


def test_cli_help_exits_cleanly() -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0


def test_installed_entry_point_delegates_to_vnext() -> None:
    """`uv run strive` (the console script) is installed and delegates to vNext."""
    result = subprocess.run(
        [sys.executable, "-m", "strive.cli", "--help"],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0
    assert "resume" in result.stdout and "campaign" in result.stdout
