#!/bin/sh
# Kernel on stdin/stdout: ./run.sh <data-dir>
cd "$(dirname "$0")"
[ -f _build/hatch ] || ./setup.sh >&2
exec escript _build/hatch "$@"
