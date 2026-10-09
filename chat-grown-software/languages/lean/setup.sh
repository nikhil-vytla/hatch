#!/usr/bin/env bash
# Builds the Lean preludes (Chat.Codec/Prelude/Gateway) and both kernel executables. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
python3 tools/gen_kernel_gateway.py
lake build kernel kernel_gateway >&2
