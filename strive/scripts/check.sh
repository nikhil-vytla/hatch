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
# The Harbor agent has no tests of its own here; it must at least parse.
python3 -m py_compile harbor/strive_agent.py
bunx biome format packages apps
bunx oxlint --deny-warnings packages apps
bunx tsc -p tsconfig.json
bunx tsc -p apps/desktop/tsconfig.json
bun test packages apps/desktop/src
# The desktop app, driven through Playwright under Node (its Electron driver
# needs Node), against the daemon cargo test just built.
bun run --cwd apps/desktop build
if [ "$(uname)" = Darwin ] || [ -n "${DISPLAY:-}" ]; then
  node --test "apps/desktop/test/*.e2e.ts"
elif command -v xvfb-run >/dev/null; then
  xvfb-run -a node --test "apps/desktop/test/*.e2e.ts"
else
  echo "skipping the desktop tests: no display (install xvfb)" >&2
fi
echo "all checks passed"
