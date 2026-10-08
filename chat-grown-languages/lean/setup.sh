#!/usr/bin/env bash
# Builds the Lean prelude (Chat.Prelude) and the kernel executable. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
lake build kernel >&2
