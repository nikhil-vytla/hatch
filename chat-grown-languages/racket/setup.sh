#!/bin/sh
# Precompile (idempotent). compiled/ is gitignored.
cd "$(dirname "$0")" && raco make -v kernel.rkt lang.rkt
