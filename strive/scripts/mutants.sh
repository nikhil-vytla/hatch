#!/bin/sh
# Mutation testing: every surviving mutant is a defect no test would catch.
# Covers the crates whose logic is pure enough to mutate quickly.
set -eu
cd "$(dirname "$0")/.."
# Mutants run the tests; no test may hold a real provider key.
unset ANTHROPIC_API_KEY OPENAI_API_KEY
command -v cargo-mutants >/dev/null || { echo "install with: cargo install cargo-mutants --locked" >&2; exit 1; }
cargo mutants --no-shuffle -j 4 -p strive-journal -p strive-proto -p strive-budget -p strive-gateway -p strive-learning "$@"
