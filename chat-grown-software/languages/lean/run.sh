#!/usr/bin/env bash
# Starts the kernel on <data-dir>. SCENARIO=gateway selects the LLM-gateway kernel (default: expenses).
set -euo pipefail
cd "$(dirname "$0")"
exe=kernel; [ "${SCENARIO:-expenses}" = gateway ] && exe=kernel_gateway
[ -x .lake/build/bin/$exe ] || ./setup.sh
exec .lake/build/bin/$exe "$@"
