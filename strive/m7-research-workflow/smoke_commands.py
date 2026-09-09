"""Exercise installed CLI examples with deterministic fixture providers only."""
import json
import os
from pathlib import Path
import shutil
import subprocess


def main() -> None:
    folder = Path(__file__).resolve().parent
    root = folder.parent
    execution = folder / ".smoke-final"
    execution.mkdir(exist_ok=False)
    program = shutil.which("strive")
    assert program is not None
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(root / "adapters/counter/src") + os.pathsep + environment.get("PYTHONPATH", "")
    examples = folder / "examples"
    tasks = [
        ("run", ["run", str(examples / "counter.toml"), "--id", "adapting-17"]),
        ("resume", ["resume", "adapting-17"]),
        ("fixed", ["run", str(examples / "fixed.toml"), "--id", "fixed-17"]),
        ("compare", ["compare", "fixed-17", "adapting-17", "--spec", str(examples / "paired.toml")]),
        ("descriptive", ["compare", "fixed-17", "adapting-17", "--spec", str(examples / "descriptive.toml"),
                         "--out", str(execution / "descriptive")]),
        ("status", ["status", "adapting-17", "--follow"]),
        ("experiment", ["experiment", str(examples / "study.toml")]),
        ("project", ["project", "adapting-17", "--profile", "langfuse"]),
    ]
    results = []
    for name, arguments in tasks:
        command = [program, "--root", str(execution / "state"), *arguments]
        result = subprocess.run(command, cwd=root, env=environment, capture_output=True, text=True, timeout=240)
        (execution / (name + ".stdout")).write_text(result.stdout)
        (execution / (name + ".stderr")).write_text(result.stderr)
        results.append({"command": name, "arguments": arguments, "exit_code": result.returncode})
        print(f"{name}: {result.returncode}", flush=True)
        if result.returncode:
            raise AssertionError(result.stderr)
    (folder / "command-smoke.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
