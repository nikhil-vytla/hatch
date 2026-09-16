#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=a2c024725189473d2d7cea3a5cfdbcc67478e41f
source_dir="$PWD/adapters/tau2/upstream-source"
# This environment intentionally has no dependency on strive's legacy DSPy.
uv sync --project adapters/tau2 --extra telecom --python /usr/local/bin/python3.12 --exclude-newer 2026-09-09T00:00:00Z
uv pip install --python adapters/tau2/.venv/bin/python --no-deps -e .
if [[ ! -d "$source_dir/.git" ]]; then
    mkdir -p "$source_dir"
    git -C "$source_dir" init --quiet
    git -C "$source_dir" remote add origin https://github.com/sierra-research/tau2-bench.git
fi
git -C "$source_dir" fetch --depth 1 origin "$revision"
git -C "$source_dir" checkout --detach --force "$revision"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]]
adapters/tau2/.venv/bin/python -I -B -m strive_benchmark_tau2.prepare \
    "$source_dir" "$PWD/adapters/tau2/retained-data" "$PWD/adapters/tau2/qualification_assertions.json"
mkdir -p .container-results
uv pip freeze --python adapters/tau2/.venv/bin/python > .container-results/tau2-installed.txt
cp adapters/tau2/uv.lock .container-results/tau2-uv.lock
