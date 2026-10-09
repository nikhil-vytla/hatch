#!/bin/sh
# Records the hostile-code showcase: Racket kernel attacks, then the same attacks on node:vm.
# Deliberately hostile (part 2 really reads /etc/passwd and runs `id`): refuses to run unless HATCH_RUN_ATTACKS=1.
# Use a throwaway container or VM.
if [ "$HATCH_RUN_ATTACKS" != "1" ]; then
  echo "run.sh: deliberately hostile demo; set HATCH_RUN_ATTACKS=1 to run it (use a throwaway container or VM)" >&2
  exit 2
fi
cd "$(dirname "$0")/.." || exit 1
echo "=== PART 1: Racket kernel (static gate + racket/sandbox) ==="
racket showcase/attacks.rkt 2>&1
echo
echo "=== PART 2: the same class of attacks against node:vm (the chat-grown-software prototype's isolation) ==="
node showcase/vm-attacks.mjs 2>&1
