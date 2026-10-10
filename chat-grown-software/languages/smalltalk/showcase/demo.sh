#!/bin/bash
# Records the showcase: part 1 over the protocol, part 2 inside the saved world image. Output: showcase/transcript.txt
set -euo pipefail
cd "$(dirname "$0")/.."
export DEMO_DIR="$(mktemp -d)"
{
  node showcase/demo.mjs
  echo
  CK_DATA="$DEMO_DIR" bash -c 'cd "$CK_DATA" && /opt/pharo/vm/pharo --headless world.image st "'"$PWD"'/showcase/shape.st" 2>&1 | head -60'
  echo
  echo "world image on disk: $(ls -l "$DEMO_DIR/world.image" | awk '{print $5}') bytes; world.json: $(ls -l "$DEMO_DIR/world.json" | awk '{print $5}') bytes"
} | tee showcase/transcript.txt
rm -rf "$DEMO_DIR"
