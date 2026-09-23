#!/bin/sh
# Everything CI runs. Order matters: cargo test builds the binary the TS tests
# drive and regenerates the protocol bindings the drift check compares.
set -eu
cd "$(dirname "$0")/.."
# No test may reach a real provider, so none may hold a real key.
unset ANTHROPIC_API_KEY OPENAI_API_KEY

cargo fmt --check
cargo clippy --all-targets --quiet -- -D warnings
cargo test --quiet

gen=packages/protocol/src/generated
if ! git diff --quiet -- "$gen" || [ -n "$(git ls-files --others --exclude-standard -- "$gen")" ]; then
  echo "protocol drift: $gen differs from the Rust types; commit the regenerated files" >&2
  git status --short -- "$gen" >&2
  exit 1
fi

bun install --frozen-lockfile --silent
bunx biome format packages
bunx oxlint --deny-warnings packages
bunx tsc -p tsconfig.json
bun test
echo "all checks passed"
