#!/usr/bin/env bash
set -euo pipefail
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PREFIX="$HOME/Library/Application Support/Jev/toolkit"
PYTHON=python3
MODEL_REGISTRY="$SOURCE_DIR/models.json"
while (($#)); do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --python) PYTHON="$2"; shift 2 ;;
    --model-registry) MODEL_REGISTRY="$2"; shift 2 ;;
    *) echo "Usage: bash install.sh [--prefix PATH] [--python PYTHON] [--model-registry PATH]" >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Jev MLX inference requires Apple Silicon macOS.' >&2
  exit 2
fi
if [[ -e "$PREFIX" ]] && { [[ ! -f "$PREFIX/.jev-toolkit" ]] || [[ "$(cat "$PREFIX/.jev-toolkit")" != 'jev-local-toolkit-v1' ]]; }; then
  echo 'Refusing to replace an existing directory without a Jev installation marker.' >&2
  exit 2
fi
mkdir -p "$PREFIX/lib" "$PREFIX/bin"
printf '%s\n' 'jev-local-toolkit-v1' > "$PREFIX/.jev-toolkit"
cp "$SOURCE_DIR/jev_local.py" "$SOURCE_DIR/requirements-inference.txt" "$PREFIX/lib/"
cp "$SOURCE_DIR/CREDITS.md" "$PREFIX/CREDITS.md"
cp "$MODEL_REGISTRY" "$PREFIX/lib/models.json"
cp "$SOURCE_DIR/../../local-models-and-games/apple/mlx_model.py" "$PREFIX/lib/mlx_model.py"
mkdir -p "$PREFIX/lib/checkpoints"
cp "$SOURCE_DIR/../training/checkpoints/laya-17.safetensors" "$PREFIX/lib/checkpoints/"
if command -v uv >/dev/null 2>&1; then
  uv venv --python "$PYTHON" "$PREFIX/venv"
  uv pip install --python "$PREFIX/venv/bin/python" -r "$PREFIX/lib/requirements-inference.txt"
else
  "$PYTHON" -m venv "$PREFIX/venv"
  "$PREFIX/venv/bin/python" -m pip install -r "$PREFIX/lib/requirements-inference.txt"
fi
cat > "$PREFIX/bin/jev-local" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec "$ROOT/venv/bin/python" "$ROOT/lib/jev_local.py" "$@"
LAUNCH
chmod +x "$PREFIX/bin/jev-local"
printf 'Installed %s\n' "$PREFIX/bin/jev-local"
"$PREFIX/bin/jev-local" doctor --runtime-only
