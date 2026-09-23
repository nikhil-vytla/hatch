#!/bin/sh
# Mutation testing: every surviving mutant is a defect no test would catch.
# Covers the crates whose logic is pure enough to mutate quickly.
set -eu
cd "$(dirname "$0")/.."
command -v cargo-mutants >/dev/null || { echo "install with: cargo install cargo-mutants --locked" >&2; exit 1; }
cargo mutants --no-shuffle -j 4 -p strive-journal -p strive-proto "$@"
