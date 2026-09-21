"""Compare installed MLX readout runtime with saved study predictions offline."""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
from unittest.mock import patch

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--runtime-dir', type=Path, required=True)
p.add_argument('--data', type=Path, required=True)
p.add_argument('--reference', type=Path, required=True)
p.add_argument('--output', type=Path, default=Path(__file__).resolve().parent / 'readout-runtime-verification.json')
a = p.parse_args()
spec = importlib.util.spec_from_file_location('installed_jev_runtime', a.runtime_dir / 'jev_local.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = [json.loads(line) for line in a.reference.read_text().splitlines()]
chosen = [row for kind in ['choice', 'boolean', 'ordinal'] for row in [r for r in rows if r['question']['kind'] == kind][:5]]
checks = []

def denied(*args, **kwargs):
    raise RuntimeError('Network is forbidden during local runtime verification')

with patch.object(socket, 'create_connection', denied), patch.object(socket.socket, 'connect', denied):
    runtime = module.Runtime('laya-readout-experimental', a.data)
    for row in chosen:
        result = runtime.decide({'schemaVersion': '1', 'requestId': row['id'], 'state': row['state'], 'questions': [row['question']]})
        if result['status'] != 'ok':
            raise ValueError('Installed runtime rejected a covered validation case: ' + row['id'])
        distribution = result['decisions'][0]['distribution']
        values = [x['value'] for x in distribution]
        if values != row['values']:
            raise ValueError('Installed runtime changed value identities')
        actual = [x['probability'] for x in distribution]
        delta = max(abs(x - y) for x, y in zip(actual, row['probabilities']))
        checks.append({'id': row['id'], 'kind': row['question']['kind'], 'maxProbabilityDelta': delta})
report = {'status': 'passed' if all(x['maxProbabilityDelta'] < 1e-4 for x in checks) else 'failed', 'installedRuntimeDirectory': str(a.runtime_dir), 'model': runtime.spec['model'], 'revision': runtime.spec['revision'], 'networkBlocked': True, 'validationOnly': True, 'decisions': len(checks), 'maxProbabilityDelta': max(x['maxProbabilityDelta'] for x in checks), 'checks': checks}
a.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'checks'}))
if report['status'] != 'passed': raise SystemExit(1)
