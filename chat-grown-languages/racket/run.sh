#!/bin/sh
# Racket live kernel: run.sh <data-dir>
cd "$(dirname "$0")" && exec racket kernel.rkt "$@"
