#!/usr/bin/env bash
set -euo pipefail
cd /workspace/strive
export STRIVE_REQUIRE_JAIL=1 STRIVE_PRIVATE_CONTAINER_CGROUP=1 STRIVE_REQUIRE_TAU2=1
export STRIVE_TAU2_PYTHON="$PWD/adapters/tau2/.venv/bin/python"
export TAU2_DATA_DIR="$PWD/adapters/tau2/retained-data"
export PYTHONPATH="$PWD/adapters/tau2/src"
python scripts/prepare-cgroup.py
if [[ "$1" == qualify ]]; then
  uv run --no-sync pytest tests/vnext/test_linux_jail.py tests/vnext/test_live_campaign.py \
    tests/vnext/test_openai_live_transport.py \
    tests/vnext/test_tau2_live.py tests/vnext/test_tau2_worker_regressions.py -q
else
  # This real native CLI smoke uses a scripted provider and spends nothing.
  # A jail/protocol failure aborts before the live entrypoint sees a credential.
  uv run --no-sync pytest tests/vnext/test_live_campaign.py::test_native_opencode_inside_linux_jail_without_spending -q
  exec uv run --no-sync strive --root /results "$@"
fi
