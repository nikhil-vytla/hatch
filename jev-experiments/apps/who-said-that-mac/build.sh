#!/bin/bash
# PROTOTYPE — builds WhoSaidThat.app (menu bar only), ad-hoc signed, pointing at this checkout's
# pipeline and your Bun. Run from anywhere: ./build.sh, then open build/WhoSaidThat.app
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bun="$(command -v bun)"
app="$here/build/WhoSaidThat.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/WhoSaidThat" "$here/Sources/main.swift" -framework AppKit -framework AVFoundation
sed -e "s#__REPO__#$repo#" -e "s#__BUN__#$bun#" "$here/Info.plist" > "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "$app"
