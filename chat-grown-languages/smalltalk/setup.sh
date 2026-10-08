#!/bin/bash
# Build build/kernel.image = the stock Pharo 12 image + the ChatKernel package (src/, Tonel). Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC=/opt/pharo
if [ -f "$HERE/build/kernel.image" ] && [ "$HERE/build/kernel.image" -nt "$HERE/build.st" ] && [ -z "$(find "$HERE/src" -newer "$HERE/build/kernel.image" -type f | head -1)" ]; then
  exit 0
fi
rm -rf "$HERE/build"; mkdir -p "$HERE/build"
cp "$SRC/Pharo.image" "$HERE/build/kernel.image"
cp "$SRC/Pharo.changes" "$HERE/build/kernel.changes"
ln -s "$SRC/"*.sources "$HERE/build/"
cd "$HERE"
"$SRC/vm/pharo" --headless "$HERE/build/kernel.image" st "$HERE/build.st" 2>&1 | head -40 >&2
test -f "$HERE/build/kernel.image"
echo "built $HERE/build/kernel.image" >&2
