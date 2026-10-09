#!/bin/sh
# Records the hostile-code showcase: Racket kernel attacks, then the same attacks on node:vm.
cd "$(dirname "$0")/.." || exit 1
echo "=== PART 1: Racket kernel (static gate + racket/sandbox) ==="
racket showcase/attacks.rkt 2>&1
echo
echo "=== PART 2: the same class of attacks against node:vm (the chat-grown-software prototype's isolation) ==="
node showcase/vm-attacks.mjs 2>&1
