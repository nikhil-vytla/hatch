#!/bin/bash
# Records showcase/gateway-transcript.txt (SCENARIO=gateway live-console demo).
set -euo pipefail
cd "$(dirname "$0")/.."
export DEMO_DIR="$(mktemp -d)"
node showcase/gateway-demo.mjs 2>&1 | tee showcase/gateway-transcript.txt
rm -rf "$DEMO_DIR"
