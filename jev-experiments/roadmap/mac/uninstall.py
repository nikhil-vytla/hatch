"""Remove only a marked Jev toolkit installation; model deletion is explicit."""
import argparse
import json
from pathlib import Path
import shutil

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--prefix', type=Path, default=Path.home() / 'Library/Application Support/Jev/toolkit')
p.add_argument('--models', type=Path, help='Optionally remove this model directory after verifying it contains only known model names')
a = p.parse_args()
root = a.prefix.resolve()
marker = root / '.jev-toolkit'
if not marker.is_file() or marker.read_text().strip() != 'jev-local-toolkit-v1':
    raise SystemExit('Refusing to delete a directory without the exact Jev installation marker')
if root in [Path('/'), Path.home(), Path.cwd()] or len(root.parts) < 4:
    raise SystemExit('Refusing unsafe installation path')
if a.models:
    model_root = a.models.resolve()
    children = list(model_root.iterdir()) if model_root.is_dir() else []
    manifest = json.loads((Path(__file__).resolve().parent / 'models.json').read_text())
    if not children or any(x.name not in manifest['models'] or not (x / 'model.safetensors').is_file() for x in children):
        raise SystemExit('Refusing model directory with unknown contents')
    for child in children:
        known = {item['path'] for item in manifest['models'][child.name]['files']}
        actual = {str(item.relative_to(child)) for item in child.rglob('*') if item.is_file()}
        if actual != known or any(item.is_symlink() for item in child.rglob('*')):
            raise SystemExit('Refusing model directory with unknown files or symlinks')
    shutil.rmtree(model_root)
shutil.rmtree(root)
print('Removed Jev toolkit' + (' and models.' if a.models else '; model files retained.'))
