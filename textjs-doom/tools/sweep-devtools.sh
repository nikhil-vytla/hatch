#!/usr/bin/env bash
# DevTools throughput sweep: for each "COLSxROWS BITS BUDGET", run the attract-mode
# demo with the Console panel open and report page fps vs. frames DevTools shows.
#   tools/sweep-devtools.sh http://localhost:3123/ outdir "80x31 8 1e9" "160x61 8 15000 css=bare" ...
# An optional 4th field is appended to the query string and to the screenshot name.
set -u
URL=$1; OUT=$2; shift 2
mkdir -p "$OUT"
for cfg in "$@"; do
  set -- $cfg
  EXTRA=${4:-}
  BITS=$2 BUDGET=$3 TAG=$EXTRA MODE=throughput SECS=${SECS:-10} SIZE=$1 WIN=1920,1280 SPLIT=1000 \
    timeout 150 xvfb-run -a -s "-screen 0 1920x1280x24" \
    node "$(dirname "$0")/devtools-shot.mjs" "${URL}?bits=$2&budget=$3&$EXTRA" "$OUT" 2>&1 | grep THROUGHPUT \
    | BUDGET=$3 EXTRA=$EXTRA python3 -c 'import json,os,sys
for l in sys.stdin:
    r = json.loads(l.split(" ", 1)[1]); r.update(budget=os.environ["BUDGET"], extra=os.environ["EXTRA"]); print("THROUGHPUT", json.dumps(r))'
done
