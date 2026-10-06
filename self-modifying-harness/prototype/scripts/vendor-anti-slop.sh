#!/usr/bin/env bash
# Fetch dmmulroy/anti-slop at a pinned commit and copy its Oxlint plugin into
# tools/oxlint/anti-slop/ (gitignored: third-party code is never committed).
set -euo pipefail

REPO="https://github.com/dmmulroy/anti-slop"
COMMIT="c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/tools/oxlint/anti-slop"

if [ -e "$dest" ]; then
  echo "anti-slop already vendored at $dest; skipping (delete it to re-vendor)."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet "$REPO" "$tmp/anti-slop"
git -C "$tmp/anti-slop" checkout --quiet "$COMMIT"
src="$tmp/anti-slop/skills/install-anti-slop/assets/anti-slop"
[ -f "$src/index.ts" ] || { echo "plugin assets not found at $src" >&2; exit 1; }

mkdir -p "$(dirname "$dest")"
cp -R "$src" "$dest"
cat > "$dest/UPSTREAM.md" <<EOT
source: $REPO
commit: $COMMIT
EOT
echo "Vendored anti-slop @ $COMMIT into $dest"
