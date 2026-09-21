"""Verify the contract review slice against clean Git source, without providers."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
patch = HERE / 'existing-contracts.patch'
rows = []
with tempfile.TemporaryDirectory(prefix='jev-contract-check-') as directory:
    destination = Path(directory)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['git', 'archive', 'HEAD'], cwd=ROOT, stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as source:
            source.extractall(destination, filter='data')
    shutil.copytree(HERE, destination / 'jev-experiments/roadmap/runtime', dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.local.*'))
    commands = [
        (['git', 'apply', '--check', 'jev-experiments/roadmap/runtime/existing-contracts.patch'], '.'),
        (['git', 'apply', 'jev-experiments/roadmap/runtime/existing-contracts.patch'], '.'),
        (['bun', 'install', '--frozen-lockfile'], 'jev-experiments/adapters/typescript'),
        (['bun', 'test', 'jev-experiments/roadmap/runtime'], '.'),
    ]
    for command, cwd in commands:
        start = time.perf_counter()
        result = subprocess.run(command, cwd=destination / cwd, capture_output=True, text=True, timeout=120)
        rows.append({'command': command, 'cwd': cwd, 'exitCode': result.returncode,
                     'elapsedSeconds': time.perf_counter() - start, 'output': (result.stdout + result.stderr)[-12000:]})
        print(('PASS ' if result.returncode == 0 else 'FAIL ') + ' '.join(command), flush=True)
        if result.returncode:
            break
report = {'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(), 'providerCalls': False,
          'checks': rows, 'passed': len(rows) == len(commands) and all(row['exitCode'] == 0 for row in rows)}
(HERE / 'standalone-check.json').write_text(json.dumps(report, indent=2) + '\n')
if not report['passed']:
    raise SystemExit(1)
