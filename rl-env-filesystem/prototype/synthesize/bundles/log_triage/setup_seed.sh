#!/bin/sh
# Materialize seed files into the sandbox working directory from the
# content-addressed store. Hardlink when possible (zero-copy), else copy.
# STORE is mounted read-only into the sandbox by the platform.
set -e
STORE="${STORE:-/store}"
DEST="${DEST:-/work/seed}"
mkdir -p "$DEST"
mkdir -p "$DEST/$(dirname "policy.txt")" 2>/dev/null || true
ln "$STORE/objects/43/43612bb39effd670b248776a0f0fefc49f9d0a175159d95f6a31d2724373602f" "$DEST/policy.txt" 2>/dev/null || cp "$STORE/objects/43/43612bb39effd670b248776a0f0fefc49f9d0a175159d95f6a31d2724373602f" "$DEST/policy.txt"
mkdir -p "$DEST/$(dirname "service.log")" 2>/dev/null || true
ln "$STORE/objects/91/91f2de94ba20a6c7643af70e37cb153b309cd31ca16c125a3529138708dcfb4c" "$DEST/service.log" 2>/dev/null || cp "$STORE/objects/91/91f2de94ba20a6c7643af70e37cb153b309cd31ca16c125a3529138708dcfb4c" "$DEST/service.log"
