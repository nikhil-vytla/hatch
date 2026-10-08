#!/usr/bin/env bash
# Starts the kernel on <data-dir>. Builds on first use if setup.sh has not run.
set -euo pipefail
cd "$(dirname "$0")"
[ -x .lake/build/bin/kernel ] || ./setup.sh
exec .lake/build/bin/kernel "$@"
