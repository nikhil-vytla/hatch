#!/bin/sh
# Materialize seed files into the sandbox working directory from the
# content-addressed store. Hardlink when possible (zero-copy), else copy.
# STORE is mounted read-only into the sandbox by the platform.
set -e
STORE="${STORE:-/store}"
DEST="${DEST:-/work/seed}"
mkdir -p "$DEST"
mkdir -p "$DEST/$(dirname "expenses.csv")" 2>/dev/null || true
ln "$STORE/objects/d8/d81072634a69588ae88aa111a9af7fa5675d44055b5deb6b5f865d3e98b1e9af" "$DEST/expenses.csv" 2>/dev/null || cp "$STORE/objects/d8/d81072634a69588ae88aa111a9af7fa5675d44055b5deb6b5f865d3e98b1e9af" "$DEST/expenses.csv"
mkdir -p "$DEST/$(dirname "policy.txt")" 2>/dev/null || true
ln "$STORE/objects/43/43612bb39effd670b248776a0f0fefc49f9d0a175159d95f6a31d2724373602f" "$DEST/policy.txt" 2>/dev/null || cp "$STORE/objects/43/43612bb39effd670b248776a0f0fefc49f9d0a175159d95f6a31d2724373602f" "$DEST/policy.txt"
