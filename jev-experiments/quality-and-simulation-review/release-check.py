"""Bounded local release check. Prints counts and paths, never credential values."""
from pathlib import Path
import json, re, shlex, subprocess, sys

root = Path(__file__).resolve().parents[2]
changed = subprocess.check_output(['git', 'diff', '--name-only', '-z', 'origin/main'], cwd=root)
untracked = subprocess.check_output(['git', 'ls-files', '-z', '-o', '--exclude-standard'], cwd=root)
paths = (changed + untracked).decode().split('\0')
source = sorted({root / p for p in paths if p.startswith('jev-experiments/') and (root / p).is_file()})
dist = root / 'jev-experiments/experience-prototypes/dist'
built = [p for p in dist.rglob('*') if p.is_file()] if dist.exists() else []
credentials = set()
config = Path.home() / '.zshrc'
if config.exists():
    for line in config.read_text().splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$', line)
        if not match or not re.search('KEY|TOKEN|SECRET', match[1]):
            continue
        try:
            values = shlex.split(match[2], comments=True)
        except ValueError:
            continue
        if len(values) == 1 and len(values[0]) >= 12 and not re.search(r'[$`\s]', values[0]):
            credentials.add(values[0].encode())
vercel_auth = Path.home() / 'Library/Application Support/com.vercel.cli/auth.json'
if vercel_auth.exists():
    token = json.loads(vercel_auth.read_text()).get('token')
    if isinstance(token, str) and len(token) >= 12:
        credentials.add(token.encode())
leaks, large_binaries = [], []
for path in source + built:
    data = path.read_bytes()
    if any(secret in data for secret in credentials):
        leaks.append(str(path.relative_to(root)))
    if path in source and len(data) >= 2_000_000:
        try:
            data.decode('utf-8')
        except UnicodeDecodeError:
            large_binaries.append(str(path.relative_to(root)))
result = {'changed_or_new_source_files': len(source), 'built_files': len(built), 'literal_credentials_checked': len(credentials), 'credential_match_files': sorted(set(leaks)), 'new_binary_files_at_least_2MB': large_binaries, 'note': 'Exact local literal credential scan plus binary-size policy. Not a comprehensive security audit.'}
print(json.dumps(result, indent=2))
if leaks or large_binaries or not credentials:
    sys.exit(1)
