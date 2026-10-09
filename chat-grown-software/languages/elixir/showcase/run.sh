#!/bin/sh
# Records the transcript: showcase/run.sh | tee showcase/transcript.txt
cd "$(dirname "$0")/.."
MIX_ENV=prod mix run showcase/live_migration.exs 2>/dev/null
