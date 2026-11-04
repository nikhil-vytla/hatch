#!/usr/bin/env bash
# Build doom.wasm from a doomgeneric checkout (tested at ozkl/doomgeneric e257a09, GPL-2.0) using zig's bundled clang + wasi-libc.
#   ./build.sh /path/to/doomgeneric  [out.wasm]
set -euo pipefail
DG=${1:?path to doomgeneric checkout}/doomgeneric
OUT=${2:-$(dirname "$0")/../app/public/doom.wasm}
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-"python3 -m ziglang"}
SRCS="$(cd "$DG" && grep '^SRC_DOOM' Makefile | sed 's/SRC_DOOM = //; s/\.o/.c/g; s/doomgeneric_xlib.c//') mus2mid.c"
mkdir -p "$(dirname "$OUT")"
args=()
for s in $SRCS; do args+=("$DG/$s"); done
$ZIG cc -target wasm32-wasi -Os -s -mexec-model=reactor \
  -DFEATURE_SOUND -I"$HERE/stub" -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -Wno-everything -I"$DG" \
  "${args[@]}" "$HERE/doomgeneric_textjs.c" "$HERE/doomgeneric_textjs_sound.c" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -Wl,--export=malloc \
  -o "$OUT"
ls -la "$OUT"
