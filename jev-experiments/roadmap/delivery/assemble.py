"""Copy one review slice into the separately created delivery Git worktree.

This does not commit, push, create PRs, apply the app patch or deploy. Source
selection is explicit and excludes caches, logs and unselected captured images.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROADMAP = HERE.parent
ROOT = ROADMAP.parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('slice', choices=['runtime', 'routing', 'training', 'playable', 'integration'])
parser.add_argument('--destination', type=Path, required=True)
parser.add_argument('--stage', action='store_true')
args = parser.parse_args()
destination = args.destination.resolve()
actual_root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=destination, text=True).strip()).resolve()
if destination == ROOT or destination != actual_root:
    raise SystemExit('Use the separate delivery worktree root, not the implementation tree.')

selected_images = set((ROADMAP / 'playable/review/artifacts/selected-binaries.txt').read_text().splitlines())
skip_directories = {'node_modules', '__pycache__', '.cache', '.venv', 'dist', '.git', '.playwright-cli'}
app_files = {'routing/ModelRoutingLab.tsx', 'routing/evidence-links.ts', 'routing/web-handler.ts',
             'training/TypedDecisionStudy.tsx', 'training/study.css'}

def group(path):
    name = str(path.relative_to(ROADMAP))
    if name in {'.gitignore', 'package.json', 'bun.lock', 'tsconfig.json', 'assets.d.ts'} or name.startswith('runtime/'):
        return 'runtime'
    if name in app_files or name.startswith('playable/review/'):
        return 'integration'
    if name.startswith(('routing/', 'integration/')) or name == 'mac/models.json':
        return 'routing'
    if name.startswith(('training/', 'mac/')):
        return 'training'
    if name.startswith(('materials/', 'playable/', 'tetris/', 'design-research/')):
        return 'playable'
    return 'integration'

rows = []
for source in sorted(ROADMAP.rglob('*')):
    relative = source.relative_to(ROADMAP)
    if any(part in skip_directories for part in relative.parts):
        continue
    if not source.is_file() or '.local.' in source.name or source.suffix == '.pyc' or source.name == '.DS_Store':
        continue
    repo_path = str(source.relative_to(ROOT))
    if 'output' in relative.parts and repo_path not in selected_images:
        continue
    if group(source) != args.slice:
        continue
    if source.is_symlink():
        raise SystemExit(f'Unexpected symlink: {repo_path}')
    data = source.read_bytes()
    try:
        data.decode('utf-8')
        binary = False
    except UnicodeDecodeError:
        binary = True
    if binary and len(data) >= 2_000_000:
        raise SystemExit(f'Binary exceeds research artifact limit: {repo_path}')
    target = destination / repo_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    rows.append({'path': repo_path, 'bytes': len(data), 'binary': binary,
                 'sha256': hashlib.sha256(data).hexdigest()})
if args.stage:
    # Stage only the enumerated authored files, including the 20 reviewed images.
    for offset in range(0, len(rows), 100):
        subprocess.run(['git', 'add', '-f', '--', *[row['path'] for row in rows[offset:offset + 100]]], cwd=destination, check=True)
    staged = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=destination, text=True).splitlines()
    if any(not path.startswith('jev-experiments/roadmap/') for path in staged):
        raise SystemExit('Unexpected staged path outside the research folder; do not commit.')
print(json.dumps({'slice': args.slice, 'files': len(rows), 'bytes': sum(row['bytes'] for row in rows), 'staged': args.stage}, indent=2))
