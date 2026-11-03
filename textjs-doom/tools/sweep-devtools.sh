#!/usr/bin/env bash
# DevTools throughput sweep: for each "COLSxROWS BITS BUDGET", run the attract-mode
# demo with the Console panel open and report page fps vs. frames DevTools shows.
#   tools/sweep-devtools.sh http://localhost:3123/ outdir "80x31 8 1e9" "160x61 8 15000" ...
set -u
URL=$1; OUT=$2; shift 2
mkdir -p "$OUT"
for cfg in "$@"; do
  set -- $cfg
  BITS=$2 BUDGET=$3 MODE=throughput SECS=${SECS:-10} SIZE=$1 WIN=1920,1280 SPLIT=1000 \
    timeout 150 xvfb-run -a -s "-screen 0 1920x1280x24" \
    node "$(dirname "$0")/devtools-shot.mjs" "${URL}?bits=$2&budget=$3" "$OUT" 2>&1 | grep THROUGHPUT | sed "s/}\$/,\"budget\":\"$3\"}/"
done
