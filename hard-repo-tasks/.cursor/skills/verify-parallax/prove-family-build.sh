#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
RUN_ID="${1:-unit0-family-build}"

if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "run ID may contain only letters, digits, dot, underscore, and hyphen" >&2
  exit 2
fi

SCRATCH="$SKILL_DIR/.scratch/$RUN_ID"
EVIDENCE="$SKILL_DIR/evidence/$RUN_ID"
STAGING="$SCRATCH/proof"
TRANSCRIPT="$STAGING/transcript.txt"

if [[ -e "$SCRATCH" ]]; then
  echo "scratch path already exists: $SCRATCH" >&2
  exit 2
fi
if [[ -e "$EVIDENCE" ]]; then
  echo "evidence path already exists: $EVIDENCE" >&2
  exit 2
fi

mkdir -p "$STAGING" "$SCRATCH/config" "$(dirname "$EVIDENCE")"

publish_failed_run() {
  local status="$1"
  local stage="$2"

  cat >"$STAGING/failure-receipt.json" <<EOF
{
  "claim": "This records a failed proof attempt only. It does not establish family build, replay, or cleanup success.",
  "exit_code": $status,
  "format": "verify-parallax.family-build-failure.v1",
  "retention": "Only the transcript and explicitly captured command stdout/stderr are retained; scratch stores, caches, and credentials are excluded.",
  "run_id": "$RUN_ID",
  "stage": "$stage"
}
EOF

  mv "$STAGING" "$EVIDENCE"
  rm -rf "$SCRATCH"

  {
    printf '[failure evidence preserved] %s\n' "$EVIDENCE"
    if [[ ! -e "$SCRATCH" ]]; then
      echo "[scratch removed]"
    else
      echo "[scratch cleanup failed]"
    fi
  } >>"$EVIDENCE/transcript.txt"

  echo "command failed; evidence preserved at $EVIDENCE" >&2
  exit "$status"
}

run_logged() {
  local label="$1"
  shift
  local stdout_file="$STAGING/$label.stdout.txt"
  local stderr_file="$STAGING/$label.stderr.txt"
  local status

  {
    printf '$'
    printf ' %q' "$@"
    printf '\n'
  } >>"$TRANSCRIPT"

  set +e
  (
    cd "$ROOT"
    "$@"
  ) >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e

  {
    echo "[stdout]"
    if [[ -s "$stdout_file" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "$line"
      done <"$stdout_file"
    fi
    echo "[stderr]"
    if [[ -s "$stderr_file" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "$line"
      done <"$stderr_file"
    fi
    echo "[exit $status]"
    echo
  } >>"$TRANSCRIPT"

  if [[ "$status" -ne 0 ]]; then
    publish_failed_run "$status" "$label"
  fi
}

capture_source_provenance() {
  uv run python - "$ROOT" "$SCRATCH" "$STAGING" "$SKILL_DIR/prove-family-build.sh" <<'PY'
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

root, scratch, staging, helper = map(Path, sys.argv[1:])
pathspecs = [
    "pyproject.toml",
    "uv.lock",
    "README.md",
    "src/parallax",
    "tests/test_synthesis_kernel.py",
    "tests/fixtures/synthesis_kernel",
    ".cursor/skills/verify-parallax/prove-family-build.sh",
]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relevant_repo_files() -> list[Path]:
    files = [
        root / "pyproject.toml",
        root / "uv.lock",
        root / "README.md",
        root / "tests/test_synthesis_kernel.py",
        helper,
    ]
    files.extend(
        path
        for path in (root / "src/parallax").rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
        and path.name != ".DS_Store"
    )
    files.extend(
        root / "tests/fixtures/synthesis_kernel" / name
        for name in ("experiment.toml", "gsm8k.json", "proposal.json")
    )
    missing = [path for path in files if not path.is_file()]
    if missing:
        raise SystemExit(f"source manifest input missing: {missing[0]}")
    return sorted(set(files))


def git_state(relative: str) -> str:
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", relative],
        cwd=root,
        capture_output=True,
    )
    return "tracked" if result.returncode == 0 else "untracked"


status = subprocess.run(
    [
        "git",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *pathspecs,
    ],
    cwd=root,
    check=True,
    capture_output=True,
).stdout
(staging / "source-git-status.txt").write_bytes(status)

tracked_diff = subprocess.run(
    [
        "git",
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "HEAD",
        "--",
        *pathspecs,
    ],
    cwd=root,
    check=True,
    capture_output=True,
).stdout
tracked_diff_digest = digest(tracked_diff)
(staging / "source-tracked-diff.sha256").write_text(tracked_diff_digest + "\n")

entries: list[dict[str, object]] = []
for path in relevant_repo_files():
    data = path.read_bytes()
    relative = path.relative_to(root).as_posix()
    entries.append(
        {
            "git_state": git_state(relative),
            "path": relative,
            "sha256": digest(data),
            "size_bytes": len(data),
            "source": "worktree",
        }
    )

for name in ("experiment.toml", "gsm8k.json", "proposal.json"):
    path = scratch / "config" / name
    data = path.read_bytes()
    entries.append(
        {
            "git_state": "not-applicable",
            "path": f"copied-config/{name}",
            "sha256": digest(data),
            "size_bytes": len(data),
            "source": "copied-config",
        }
    )

head = subprocess.run(
    ["git", "rev-parse", "HEAD"],
    cwd=root,
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
manifest = {
    "base_head": head,
    "claim": (
        "These path-and-SHA-256 entries commit the exact current input bytes, "
        "including relevant untracked files, even when the worktree is uncommitted."
    ),
    "files": sorted(entries, key=lambda entry: str(entry["path"])),
    "format": "verify-parallax.source-manifest.v1",
    "git_status_pathspecs": pathspecs,
    "git_status_sha256": digest(status),
    "tracked_diff_basis": (
        "git diff --binary --full-index --no-ext-diff HEAD -- <git_status_pathspecs>"
    ),
    "tracked_diff_sha256": tracked_diff_digest,
}
manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
(staging / "source-manifest.json").write_bytes(manifest_bytes)
(staging / "source-manifest.sha256").write_text(digest(manifest_bytes) + "\n")
print(f"recorded {len(entries)} exact source inputs against base HEAD {head}")
PY
}

run_logged launch uv sync
run_logged doctor-help uv run parallax --help
run_logged doctor-import uv run python -c \
  'import parallax; print(parallax.__file__)'
run_logged doctor-fixtures uv run python -c \
  'from pathlib import Path; paths=[Path("tests/fixtures/synthesis_kernel")/name for name in ("experiment.toml","gsm8k.json","proposal.json")]; assert all(path.is_file() for path in paths); print("\n".join(str(path.resolve()) for path in paths))'

run_logged copy-fixtures cp \
  "$ROOT/tests/fixtures/synthesis_kernel/experiment.toml" \
  "$ROOT/tests/fixtures/synthesis_kernel/gsm8k.json" \
  "$ROOT/tests/fixtures/synthesis_kernel/proposal.json" \
  "$SCRATCH/config/"

run_logged source-provenance capture_source_provenance
run_logged build uv run parallax build \
  "$SCRATCH/config/experiment.toml" \
  --store "$SCRATCH/build"
run_logged replay uv run parallax build \
  --locked "$SCRATCH/config/family.lock" \
  --store "$SCRATCH/replay"
run_logged pytest uv run pytest -q \
  tests/test_synthesis_kernel.py::test_cli_build_reruns_idempotently_and_replays_lock

validate_and_write_receipt() {
  uv run python - "$ROOT" "$SCRATCH" "$STAGING" <<'PY'
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

root, scratch, staging = map(Path, sys.argv[1:])
first_result = json.loads((staging / "build.stdout.txt").read_text())
replay_result = json.loads((staging / "replay.stdout.txt").read_text())
if first_result != replay_result:
    raise SystemExit("build and replay CLI results differ")

family_id = first_result["family_id"]
first_root = scratch / "build" / family_id
replay_root = scratch / "replay" / family_id


def files(path: Path) -> dict[str, bytes]:
    return {
        item.relative_to(path).as_posix(): item.read_bytes()
        for item in sorted(path.rglob("*"))
        if item.is_file()
    }


first_files = files(first_root)
replay_files = files(replay_root)
if not first_files:
    raise SystemExit("first build emitted no artifact files")
if first_files != replay_files:
    raise SystemExit("first build and locked replay artifact bytes differ")

family = json.loads((first_root / "family.json").read_text())
if family["family_id"] != family_id:
    raise SystemExit("family artifact and CLI family IDs differ")
if not all(check["passed"] for check in family["certificate"]):
    raise SystemExit("family artifact contains a failed admission check")

source_manifest_path = staging / "source-manifest.json"
source_manifest_bytes = source_manifest_path.read_bytes()
source_manifest = json.loads(source_manifest_bytes)
if hashlib.sha256(source_manifest_bytes).hexdigest() != (
    staging / "source-manifest.sha256"
).read_text().strip():
    raise SystemExit("source manifest digest does not match its bytes")

manifest_repo_paths: set[str] = set()
for entry in source_manifest["files"]:
    relative = entry["path"]
    if entry["source"] == "worktree":
        path = root / relative
        manifest_repo_paths.add(relative)
    elif entry["source"] == "copied-config":
        path = scratch / "config" / relative.removeprefix("copied-config/")
    else:
        raise SystemExit(f"unknown source manifest scope: {entry['source']}")
    data = path.read_bytes()
    if len(data) != entry["size_bytes"]:
        raise SystemExit(f"source size changed during proof: {relative}")
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise SystemExit(f"source bytes changed during proof: {relative}")

expected_repo_paths = {
    "pyproject.toml",
    "uv.lock",
    "README.md",
    "tests/test_synthesis_kernel.py",
    ".cursor/skills/verify-parallax/prove-family-build.sh",
    "tests/fixtures/synthesis_kernel/experiment.toml",
    "tests/fixtures/synthesis_kernel/gsm8k.json",
    "tests/fixtures/synthesis_kernel/proposal.json",
}
expected_repo_paths.update(
    path.relative_to(root).as_posix()
    for path in (root / "src/parallax").rglob("*")
    if path.is_file()
    and "__pycache__" not in path.parts
    and path.suffix not in {".pyc", ".pyo"}
    and path.name != ".DS_Store"
)
if manifest_repo_paths != expected_repo_paths:
    raise SystemExit("source manifest file selection changed during proof")

pathspecs = source_manifest["git_status_pathspecs"]
current_status = subprocess.run(
    [
        "git",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *pathspecs,
    ],
    cwd=root,
    check=True,
    capture_output=True,
).stdout
if hashlib.sha256(current_status).hexdigest() != source_manifest["git_status_sha256"]:
    raise SystemExit("relevant git status changed during proof")
if current_status != (staging / "source-git-status.txt").read_bytes():
    raise SystemExit("recorded git status does not match current status")

current_diff = subprocess.run(
    [
        "git",
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "HEAD",
        "--",
        *pathspecs,
    ],
    cwd=root,
    check=True,
    capture_output=True,
).stdout
if hashlib.sha256(current_diff).hexdigest() != source_manifest["tracked_diff_sha256"]:
    raise SystemExit("relevant tracked diff changed during proof")

shutil.copytree(scratch / "config", staging / "config")
shutil.copytree(first_root, staging / "artifacts" / "build")
shutil.copytree(replay_root, staging / "artifacts" / "replay")

digests: dict[str, str] = {}
for path in sorted((staging / "artifacts").rglob("*")):
    if path.is_file():
        relative = path.relative_to(staging).as_posix()
        digests[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
(staging / "artifact-digests.json").write_text(
    json.dumps(digests, indent=2, sort_keys=True) + "\n"
)

build_digests = {
    key.removeprefix("artifacts/build/"): value
    for key, value in digests.items()
    if key.startswith("artifacts/build/")
}
replay_digests = {
    key.removeprefix("artifacts/replay/"): value
    for key, value in digests.items()
    if key.startswith("artifacts/replay/")
}
if build_digests != replay_digests:
    raise SystemExit("published build and replay digest maps differ")

head = subprocess.run(
    ["git", "rev-parse", "HEAD"],
    cwd=root,
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
receipt = {
    "artifact_file_count_per_tree": len(first_files),
    "artifact_trees_byte_identical": True,
    "arms": first_result["arms"],
    "claim": (
        "Current Parallax GSM8K family build and locked replay from a "
        "hand-authored frozen proposal."
    ),
    "claim_limits": [
        "No Microsoft Evolving Intent generation was executed.",
        (
            "The family identity includes digest-shaped placeholder prompt and "
            "response strings from the hand-authored proposal; artifact determinism "
            "does not establish provenance integrity or semantic proposal validity."
        ),
        (
            "The proposal fixture sets context to school_supply_sales for a source "
            "task about Natalia selling clips; this known mismatch is not validated "
            "by the current admission checks."
        ),
        "No upstream scheduler or renderer parity was characterized.",
        "No external benchmark assets, provider calls, or native HUD rollout were exercised.",
    ],
    "commands": {
        "build": [
            "uv",
            "run",
            "parallax",
            "build",
            str(scratch / "config" / "experiment.toml"),
            "--store",
            str(scratch / "build"),
        ],
        "locked_replay": [
            "uv",
            "run",
            "parallax",
            "build",
            "--locked",
            str(scratch / "config" / "family.lock"),
            "--store",
            str(scratch / "replay"),
        ],
    },
    "doctor": {
        "console_script": "available",
        "fixture_files": "present",
        "import_path": (staging / "doctor-import.stdout.txt").read_text().strip(),
    },
    "family_id": family_id,
    "format": "verify-parallax.family-build-proof.v2",
    "proposal_provenance": {
        "integrity": "not-proven",
        "kind": "hand-authored-placeholder",
        "known_semantic_mismatch": "school_supply_sales versus Natalia selling clips",
        "semantic_validity": "not-proven",
    },
    "pytest_support": (
        "tests/test_synthesis_kernel.py::"
        "test_cli_build_reruns_idempotently_and_replays_lock"
    ),
    "repository_head": head,
    "source_provenance": {
        "base_head": source_manifest["base_head"],
        "git_status": "source-git-status.txt",
        "git_status_sha256": source_manifest["git_status_sha256"],
        "manifest": "source-manifest.json",
        "manifest_sha256": hashlib.sha256(source_manifest_bytes).hexdigest(),
        "tracked_diff_sha256": source_manifest["tracked_diff_sha256"],
        "worktree_claim": (
            "The manifest binds exact current bytes, including relevant untracked "
            "files, rather than treating base HEAD as the complete source state."
        ),
    },
}
(staging / "receipt.json").write_text(
    json.dumps(receipt, indent=2, sort_keys=True) + "\n"
)
PY
}

run_logged receipt-validation validate_and_write_receipt

mv "$STAGING" "$EVIDENCE"
{
  printf '$ rm -rf %q\n' "$SCRATCH"
} >>"$EVIDENCE/transcript.txt"
rm -rf "$SCRATCH"

if [[ -e "$SCRATCH" ]]; then
  echo "cleanup failed: scratch still exists" >&2
  exit 1
fi
if [[ ! -d "$EVIDENCE" ]]; then
  echo "cleanup failed: evidence is missing" >&2
  exit 1
fi

{
  echo "[exit 0]"
  printf '[evidence preserved] %s\n' "$EVIDENCE"
} >>"$EVIDENCE/transcript.txt"

echo "$EVIDENCE"
