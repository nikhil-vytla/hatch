#!/bin/sh
exec node --experimental-strip-types --no-warnings "$(dirname "$0")/kernel.ts" "$1"
