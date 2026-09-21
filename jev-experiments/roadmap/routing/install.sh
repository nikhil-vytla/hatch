#!/bin/sh
set -eu
# Install an original-source bundle; no training packages or model weights.
command -v bun >/dev/null 2>&1 || { echo 'Bun is required. Install it from https://bun.sh before running this installer.' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_prefix=${1:-"$HOME/.local/share/jev-router"}
mkdir -p "$install_prefix/bin" "$install_prefix/lib"
bun build "$source_dir/cli.ts" --target bun --outfile "$install_prefix/lib/jev.js" >/dev/null
cat > "$install_prefix/bin/jev" <<'SCRIPT'
#!/bin/sh
set -eu
install_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec bun "$install_root/lib/jev.js" "$@"
SCRIPT
chmod +x "$install_prefix/bin/jev"
printf '%s\n' "Installed $install_prefix/bin/jev" "Add $install_prefix/bin to PATH, then run jev doctor." "Uninstall by removing $install_prefix. No shell or client configuration was changed."
