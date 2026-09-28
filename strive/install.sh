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

# The desktop app (strive app). STRIVE_NO_DESKTOP=1 skips it.
if [ -z "${STRIVE_NO_DESKTOP:-}" ]; then
  echo "building the desktop app..."
  SHARE="${STRIVE_SHARE:-$HOME/.local/share/strive}"
  (cd apps/desktop && bun run build.ts >/dev/null && bunx electron-builder --dir >/dev/null 2>&1)
  case "$(uname)" in
    Darwin) built=$(ls -d apps/desktop/dist/mac*/strive.app) app="strive.app" exe="strive.app/Contents/MacOS/strive" ;;
    *) built=apps/desktop/dist/linux-unpacked app="desktop" exe="desktop/strive-desktop" ;;
  esac
  mkdir -p "$SHARE"
  rm -rf "$SHARE/.$app.new" && cp -R "$built" "$SHARE/.$app.new" && rm -rf "${SHARE:?}/$app" && mv "$SHARE/.$app.new" "$SHARE/$app"
  printf '#!/bin/sh\nexec "%s/%s" "$@"\n' "$SHARE" "$exe" > "$BIN/.strive-desktop.new"
  chmod +x "$BIN/.strive-desktop.new" && mv -f "$BIN/.strive-desktop.new" "$BIN/strive-desktop"
  echo "installed the desktop app to $SHARE (strive app opens it)"
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "add $BIN to your PATH, for example: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc" ;;
esac
echo
"$BIN/strive" doctor || true
echo
echo "next: cd into any repository and run strive"
