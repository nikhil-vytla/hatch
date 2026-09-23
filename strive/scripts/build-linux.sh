#!/bin/sh
# Builds strive's Linux binaries into .audit/linux/dist/ARCH for containers
# (Harbor tasks): a static strive (musl) and strive-tui, which is also the
# agent host. ARCH is aarch64 or x86_64 (default: this machine's); a foreign
# one builds under emulation, slowly. Needs podman or docker.
set -eu
cd "$(dirname "$0")/.."
engine=$(command -v podman || command -v docker)
arch="${1:-$(uname -m | sed 's/arm64/aarch64/')}"
case "$arch" in
  aarch64) platform=linux/arm64 bun=bun-linux-arm64 ;;
  # baseline: no AVX2, which emulators may not offer
  x86_64) platform=linux/amd64 bun=bun-linux-x64-baseline ;;
  *) echo "usage: build-linux.sh [aarch64|x86_64]" >&2; exit 2 ;;
esac
job=.audit/linux
out="$job/dist/$arch"
mkdir -p "$out"
git ls-files -z | tar --null -czf "$job/src.tgz" -T -
cat > "$job/build-$arch.sh" <<INNER
set -eu
apt-get update -qq >/dev/null && apt-get install -y -qq musl-tools cmake clang >/dev/null 2>&1
rustup target add $arch-unknown-linux-musl >/dev/null 2>&1
mkdir -p /work && tar -xzf /job/src.tgz -C /work && cd /work
CARGO_TARGET_DIR=/target cargo build -q --release --target $arch-unknown-linux-musl -p strived
cp /target/$arch-unknown-linux-musl/release/strive /out/strive
INNER
"$engine" run --rm --platform "$platform" -v "$PWD/$job":/job:ro -v "$PWD/$out":/out \
  -v "strive-linux-target-$arch":/target docker.io/library/rust:latest sh "/job/build-$arch.sh"
bun build --compile --minify --target="$bun" packages/tui/src/main.ts --outfile "$out/strive-tui" >/dev/null
rm -f .*.bun-build
echo "built $out/strive and $out/strive-tui"
