#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Linux container required'; exit 1; }
version=1.18.30
case "$(uname -m)" in
  aarch64) archive=opencode-linux-arm64.tar.gz ;;
  x86_64) archive=opencode-linux-x64-baseline.tar.gz ;;
  *) echo 'Unsupported architecture'; exit 1 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 0 "https://github.com/anomalyco/opencode/releases/download/v$version/$archive" -o "$work/opencode.tar.gz"
tar -xzf "$work/opencode.tar.gz" -C "$work"
install -m 0755 "$work/opencode" /usr/local/bin/opencode
[[ "$(opencode --version)" == "$version" ]]
sha256sum /usr/local/bin/opencode
