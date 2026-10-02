#!/usr/bin/env bash
# Builds strive and strive-tui for Linux, for Harbor to put in a task's
# container: `bench/harbor/build-linux.sh [arm64|amd64]` (default: this
# machine's). Rust builds in a Debian bullseye container, so the binary
# needs glibc 2.31 or later, which every Terminal-Bench 2 image has; Bun
# cross-compiles strive-tui.
set -euo pipefail
cd "$(dirname "$0")/../.."
arch="${1:-$(uname -m)}"
case "$arch" in
  arm64 | aarch64) arch=arm64 platform=linux/arm64 ;;
  amd64 | x86_64) arch=amd64 platform=linux/amd64 ;;
  *) echo "build-linux: unknown architecture $arch (arm64 or amd64)" >&2; exit 2 ;;
esac
engine="$(command -v docker || command -v podman)"
out="target/linux-$arch"
mkdir -p "$out"
"$engine" run --rm --platform "$platform" \
  -v "$PWD":/src -w /src \
  -v strive-cargo-registry:/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR="/src/target/linux-$arch/cargo" \
  rust:1-bullseye cargo build --release --locked -p strived
cp "$out/cargo/release/strive" "$out/strive"
bun build --compile --minify --target="bun-linux-$( [ "$arch" = amd64 ] && echo x64 || echo arm64 )" \
  packages/tui/src/main.ts --outfile "$out/strive-tui" >/dev/null
echo "built $out/strive and $out/strive-tui"
