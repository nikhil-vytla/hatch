"""Check frozen/source integrity and emit an incremental patch from start bytes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(__file__).resolve().parent
BASE = ROOT / ".cache/amendment3-baseline"
start = json.loads((WORK / "starting-hashes.json").read_text())
freeze = json.loads((ROOT / "m5-investigation/second-benchmark-core-freeze.json").read_text())


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


changed = sorted(name for name, before in start.items() if not (ROOT / name).is_file() or digest(ROOT / name) != before)
current = set()
for directory, subdirectories, files in os.walk(ROOT):
    if Path(directory) == ROOT:
        subdirectories[:] = [d for d in subdirectories if d in {"src", "tests", "adapters", "docs", "scripts", ".devcontainer"}]
    subdirectories[:] = [d for d in subdirectories if d not in {".cache", ".venv", ".mypy_cache", ".pytest_cache", "__pycache__", WORK.name}]
    for filename in files:
        name = str((Path(directory) / filename).relative_to(ROOT))
        if name.startswith(("src/", "tests/", "adapters/", "docs/", "scripts/", ".devcontainer/")) or "/" not in name:
            current.add(name)
new = sorted(current - start.keys())
core = {name: digest(ROOT / name) == expected for name, expected in freeze.items()}
protected = [name for name in start if (name.startswith("src/strive/vnext/") or name in {
    "Containerfile", "scripts/prepare-cgroup.py", "scripts/build-jail-rootfs.py", "scripts/compile-seccomp.c",
    "scripts/verify-in-container.sh", "adapters/tau2/src/strive_benchmark_tau2/native_worker.py",
    "tests/vnext/test_tau2_worker_regressions.py"})]
protected_changed = sorted(name for name in protected if name in changed)
assert len(core) == 30 and all(core.values())
assert not protected_changed, protected_changed
allowed = {"adapters/tau2/README.md", "docs/ASTRA_DESIGN.md", "scripts/report-container-results.py",
           "tests/vnext/benchmark_fixtures.py", "tests/vnext/test_benchmark_qualification.py",
           "tests/vnext/test_tau2_fixed_stock.py", "tests/vnext/test_tau2_live.py"}
allowed.update("adapters/tau2/src/strive_benchmark_tau2/" + name for name in (
    "adapter.py", "certify.py", "fixed_stock.py", "live_checks.py", "qualification.py", "server.py", "splits.py"))
assert set(changed + new) <= allowed, set(changed + new) - allowed
report = {"core_hashes": core, "core_match_count": sum(core.values()), "protected_changed": protected_changed,
          "native_worker_codec_fix_unchanged": digest(ROOT / "adapters/tau2/src/strive_benchmark_tau2/native_worker.py") == start["adapters/tau2/src/strive_benchmark_tau2/native_worker.py"],
          "changed_from_start": changed, "new_source_files": new,
          "final_source_hashes": {name: digest(ROOT / name) for name in sorted(allowed)},
          "note": "Compared to initial worktree, not HEAD. No commits/history changes. No upstream execution on host."}
(WORK / "scope-verification.json").write_text(json.dumps(report, indent=2) + "\n")
patches = []
for name in sorted(changed + new):
    before = str(BASE / name) if name in changed else "/dev/null"
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "diff", "--no-index", "--", before, str(ROOT / name)],
                            capture_output=True, text=True)
    assert result.returncode in (0, 1), result.stderr
    patch = result.stdout.replace("a" + str(BASE) + "/", "a/").replace("b" + str(ROOT) + "/", "b/")
    patch = patch.replace("a" + str(ROOT) + "/", "a/")
    patches.append(patch)
(WORK / "changes.patch").write_text("".join(patches))
print(json.dumps({"core_hashes_matching": sum(core.values()), "protected_changed": protected_changed,
                  "changed": changed, "new": new}, indent=2))
