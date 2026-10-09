#!/bin/sh
# Fetch deps and build the escript (idempotent).
set -e
cd "$(dirname "$0")"
mix local.hex --force >/dev/null 2>&1 || true
mix deps.get
MIX_ENV=prod mix escript.build >/dev/null
