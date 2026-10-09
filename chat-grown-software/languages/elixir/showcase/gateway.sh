#!/bin/sh
# showcase/gateway.sh > showcase/gateway-transcript.txt
cd "$(dirname "$0")/.."
MIX_ENV=prod mix run showcase/gateway_live.exs 2>/dev/null
