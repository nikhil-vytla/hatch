#!/usr/bin/env bash
# PROTOTYPE demo: every jev-lab command, with no key and no GPU. Starts the hash mock, runs the
# commands, stops the mock it started. Run from jev-experiments/:  bash tools/decide-cli/examples/demo.sh
set -euo pipefail

cli="bun tools/decide-cli/cli.ts"
work="$(mktemp -d)"

$cli serve-mock --port 31337 > "$work/mock.log" 2>&1 &
mock=$!
trap 'kill "$mock" 2>/dev/null || true' EXIT
sleep 1

echo '$ jev-lab eval suggestion --endpoint jev --dry-run | tail -1'
$cli eval suggestion --endpoint jev --dry-run | tail -1
echo
echo '$ jev-lab eval decoy --endpoint systemone:http://localhost:31337 --out decoy.mock.jsonl'
$cli eval decoy --endpoint systemone:http://localhost:31337 --out "$work/decoy.mock.jsonl" | sed "s#$work/##"
echo
echo '$ jev-lab compare packages/arena/prose/recordings/prose.jsonl.gz decoy.mock.jsonl'
$cli compare packages/arena/prose/recordings/prose.jsonl.gz "$work/decoy.mock.jsonl"
echo
echo '$ jev-lab bouncer tools/decide-cli/fixtures/openai-booking.json'
$cli bouncer tools/decide-cli/fixtures/openai-booking.json || echo "(exit $?: the log has errors)"
