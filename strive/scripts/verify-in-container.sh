#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export STRIVE_REQUIRE_JAIL=1 STRIVE_REQUIRE_TAU2=1
export STRIVE_PRIVATE_CONTAINER_CGROUP=1
export STRIVE_CGROUP_ROOT="${STRIVE_CGROUP_ROOT:-/sys/fs/cgroup/strive-jobs}"
export STRIVE_RESULTS="$PWD/.container-results"
export STRIVE_TAU2_PYTHON="$PWD/adapters/tau2/.venv/bin/python"
export TAU2_DATA_DIR="$PWD/adapters/tau2/retained-data"
mkdir -p "$STRIVE_RESULTS"
trap 'status=$?; if (( status != 0 )); then echo "VERIFY FAILED (exit $status). See .container-results and the failing stage above."; fi' EXIT
[[ "$(uname -s)" == Linux ]] || { echo 'Linux required'; exit 1; }
uv sync --frozen --python /usr/local/bin/python3.12
bash scripts/install-tau2.sh
python scripts/prepare-cgroup.py
uv run --no-sync python - <<'PY'
from strive.runtime.linux_jail import require_capability
print("OS confinement:", require_capability().reason)
PY
set +e
uv run --no-sync mypy --strict 2>&1 | tee "$STRIVE_RESULTS/mypy.txt"
types_status=${PIPESTATUS[0]}
uv run --no-sync pytest tests/vnext -v -ra --basetemp="$STRIVE_RESULTS/pytest-tmp" --junitxml="$STRIVE_RESULTS/vnext.xml" 2>&1 | tee "$STRIVE_RESULTS/pytest.txt"
tests_status=${PIPESTATUS[0]}
set -e
python scripts/report-container-results.py "$STRIVE_RESULTS/vnext.xml" "$types_status" "$tests_status"
