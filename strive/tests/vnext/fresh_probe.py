"""Fresh interpreter test driver. Subprocesses exist only in this test helper.

The child runs read-only replay under import and Python audit guards. No
candidate program, model, harness, or external operation is dispatched.
"""

from pathlib import Path
import subprocess
import sys
import textwrap


_PROGRAM = textwrap.dedent('''
    import sys
    import os
    import importlib.abc
    from pathlib import Path

    sys.path = [p for p in sys.path if "site-packages" not in p]
    sys.path.insert(0, sys.argv[1])
    if len(sys.argv) > 5 and sys.argv[5]:
        sys.path.append(sys.argv[5])
        import importlib.metadata
        assert importlib.metadata.version("strive-benchmark-tau2") == "0.1.0"

    forbidden = ("dspy", "litellm", "openai", "anthropic", "numpy", "torch", "candidate", "tau2", "strive_benchmark_tau2", "strive_benchmark_counter",
                 "pandas", "pydantic", "httpx", "requests", "fastapi", "tenacity", "deepdiff", "dotenv", "tiktoken", "tokenizers", "strive.benchmarks")
    allowed_strive = {"strive"} | {
        "strive." + name for name in (
            "codec", "errors", "wire", "verify", "verify.engine", "store", "store.cas", "store.journal",
            "contracts", "contracts.annotations", "contracts.bindings", "contracts.commands",
            "contracts.feedback", "contracts.harness", "contracts.lifecycle", "contracts.manifest",
            "contracts.primitives", "contracts.records"
        )
    }

    class ImportGuard(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if any(fullname == name or fullname.startswith(name + ".") for name in forbidden):
                raise AssertionError("forbidden import: " + fullname)
            if fullname.startswith("strive.") and fullname not in allowed_strive:
                raise AssertionError("legacy/candidate runtime import: " + fullname)
            return None

    sys.meta_path.insert(0, ImportGuard())

    def audit(event, args):
        if event == "open":
            mode, flags = args[1], args[2]
            if isinstance(mode, str) and any(letter in mode for letter in "wax+"):
                raise AssertionError("write attempted: " + repr(args))
            if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise AssertionError("write attempted: " + repr(args))
        if event.startswith(("subprocess.", "socket.")) or event in {
            "os.system", "os.exec", "os.posix_spawn", "os.fork", "os.remove", "os.rename",
            "os.mkdir", "os.rmdir", "os.link", "os.symlink", "os.truncate", "os.chmod"
        }:
            raise AssertionError("side effect attempted: " + event)

    sys.addaudithook(audit)
    from strive.verify import replay, VerificationError
    assert "strive.store" not in sys.modules, "verifier imported mutable storage"
    from strive.store import RunReader
    from strive.contracts.primitives import RunId
    from strive.contracts.annotations import Annotation

    reader = RunReader(Path(sys.argv[2]), RunId("run-1"))
    expected_corruption = sys.argv[3] == "corrupt"
    try:
        state = replay(reader.journal, reader.objects, reader.authority)
    except VerificationError as error:
        assert expected_corruption and "artifact" in str(error), str(error)
        outcome = "CORRUPTION_REJECTED"
    else:
        assert not expected_corruption, "corrupt authority was accepted"
        if len(sys.argv) > 4 and sys.argv[4] == "benchmark":
            assert state.measurements and state.measurements[-1].metric_value == 1
            assert len(state.consumed_results) == len(state.effects)
        else:
            assert len(state.records) == 6
            assert len(state.consumed_results) == 1
            assert state.private_state == b"private-state\\x00"
            assert isinstance(state.records[-1].payload, Annotation)
            assert state.records[-1].payload.payload.startswith(b"\\xffnot JSON")
        outcome = "REPLAY_ACCEPTED"
    assert not any(name == prefix or name.startswith(prefix + ".") for name in sys.modules for prefix in forbidden)
    assert not any(name.startswith("strive.") and name not in allowed_strive for name in sys.modules)
    print(outcome + ":NO_CANDIDATE_IMPORTS:NO_WRITES:NO_DISPATCH")
''')


def fresh_replay(root: Path, *, corrupt: bool, benchmark: bool = False, installed: Path | None = None) -> None:
    source = Path(__file__).resolve().parents[2] / "src"
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", _PROGRAM, str(source), str(root), "corrupt" if corrupt else "valid",
         "benchmark" if benchmark else "storage", str(installed) if installed else ""],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, f"fresh verifier failed: stdout={result.stdout!r}, stderr={result.stderr!r}"
    expected = "CORRUPTION_REJECTED" if corrupt else "REPLAY_ACCEPTED"
    assert result.stdout.strip() == expected + ":NO_CANDIDATE_IMPORTS:NO_WRITES:NO_DISPATCH"
