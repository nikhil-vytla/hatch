#!/usr/bin/env bash
# Fetch the shareware DOOM1.WAD (v1.9) into public/. The shareware episode is
# freely redistributable but it is id Software's data, so it is not committed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/doom1.wad
URL=${DOOM_WAD_URL:-https://cdn.jsdelivr.net/gh/Akbar30Bill/DOOM_wads@master/doom1.wad}
[ -f "$OUT" ] || curl -fsSL "$URL" -o "$OUT"
SUM=$( (md5sum "$OUT" 2>/dev/null || md5 -r "$OUT") | cut -d' ' -f1)
[ "$SUM" = f0cefca49926d00903cf57551d901abe ] && echo "doom1.wad OK (shareware v1.9)" \
  || echo "warning: $OUT has md5 $SUM, not shareware v1.9 (any IWAD named doom1.wad works)"
