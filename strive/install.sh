#!/bin/sh
# Install strive from this checkout. Needs cargo and bun.
# Prebuilt `curl | sh` downloads come with the first release.
set -eu
cd "$(dirname "$0")"
BIN="${STRIVE_BIN:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "strive: install needs $1 ($2)" >&2; exit 1; }; }
need cargo "https://rustup.rs"
need bun "https://bun.sh"

echo "building strive..."
cargo build --release --quiet
bun install --frozen-lockfile --silent
bun build --compile --minify packages/tui/src/main.ts --outfile target/release/strive-tui >/dev/null
rm -f .*.bun-build  # bun leaves a temp file behind

mkdir -p "$BIN"
# Replace, don't overwrite in place: a running binary keeps its old inode.
for f in strive strive-tui; do
  cp target/release/$f "$BIN/.$f.new" && mv -f "$BIN/.$f.new" "$BIN/$f"
done
echo "installed strive and strive-tui to $BIN"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "add $BIN to your PATH, for example: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc" ;;
esac
echo
"$BIN/strive" doctor || true
echo
echo "next: cd into any repository and run strive"
