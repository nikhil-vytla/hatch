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
# The learning eval (ADR-0021): its task suite matches its builder, and its
# plan, statistics and journal reading pass their unit tests. The slower
# checks (every oracle, and the runner against a scripted model) are
# scripts/eval/selfcheck.py [--e2e]; see eval/README.md.
python3 eval/build_tasks.py --check
python3 scripts/eval/test_evallib.py
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
# Cargo never removes what earlier builds left; say so before it's a surprise.
target_gb=$(( $(du -sk target 2>/dev/null | cut -f1) / 1048576 ))
if [ "$target_gb" -ge 10 ]; then
  echo "note: target/ holds ${target_gb} GB of build output; \`cargo clean\` frees it (the next build takes about a minute)" >&2
fi
echo "all checks passed"
