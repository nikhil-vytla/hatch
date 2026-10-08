#!/bin/bash
# Kernel on <data-dir>. The world's own image lives in <data-dir>/world.image (copied from the build image on first
# start, saved again at clean shutdown); world.json is the durable record.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${1:?usage: run.sh <data-dir>}"
mkdir -p "$DATA"; DATA="$(cd "$DATA" && pwd)"
[ -f "$HERE/build/kernel.image" ] || "$HERE/setup.sh" >&2
if [ ! -f "$DATA/world.image" ]; then
  cp "$HERE/build/kernel.image" "$DATA/world.image"
  cp "$HERE/build/kernel.changes" "$DATA/world.changes"
  ln -sf /opt/pharo/*.sources "$DATA/"
fi
export CK_DATA="$DATA"
cd "$DATA"
exec /opt/pharo/vm/pharo --headless "$DATA/world.image" eval "CkKernel runFromEnvironment" 2>&2
