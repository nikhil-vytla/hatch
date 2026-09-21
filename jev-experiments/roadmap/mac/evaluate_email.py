"""Run an offline, synthetic 12-message email smoke evaluation.

Labels are committed before model predictions. This small authored fixture set
checks the example's behavior; it is not a representative email benchmark.
"""
import argparse
from collections import Counter
from email.message import EmailMessage
import hashlib
import json
from pathlib import Path
import socket
import tempfile
import time
from unittest.mock import patch

from jev_local import Runtime, classify_eml, DATA, HERE, sha

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--data', type=Path, default=DATA)
p.add_argument('--model', default='laya-base-experimental')
p.add_argument('--output', type=Path, default=HERE / 'email-evaluation.json')
a = p.parse_args()
fixtures = json.loads((HERE / 'email-fixtures.json').read_text())
rows = []

def denied(*args, **kwargs):
    raise RuntimeError('Network calls are forbidden during local inference')

with patch.object(socket, 'create_connection', denied), patch.object(socket.socket, 'connect', denied):
    runtime = Runtime(a.model, a.data)
    with tempfile.TemporaryDirectory(prefix='jev-email-eval-') as directory:
        for row in fixtures:
            message = EmailMessage()
            message['From'] = 'sender@example.invalid'
            message['To'] = 'reader@example.invalid'
            message['Subject'] = row['subject']
            message.set_content(row['body'])
            path = Path(directory) / (row['id'] + '.eml')
            path.write_bytes(message.as_bytes())
            before = sha(path)
            result = classify_eml(runtime, path)
            assert sha(path) == before, 'Email file changed'
            selected = result['decisions'][0]['selected'] if result['status'] == 'ok' else None
            rows.append({'id': row['id'], 'expected': row['label'], 'selected': selected, 'correct': selected == row['label'], 'result': result})
report = {'status': 'completed_smoke_evaluation', 'fixtureSha256': sha(HERE / 'email-fixtures.json'), 'model': runtime.spec['model'], 'revision': runtime.spec['revision'], 'cases': len(rows), 'accuracy': sum(r['correct'] for r in rows) / len(rows), 'coverage': sum(r['result']['status'] == 'ok' for r in rows) / len(rows), 'networkBlockedDuringInference': True, 'filesUnchanged': True, 'limits': 'Twelve authored synthetic messages, not a representative benchmark. Email uncertainty is uncalibrated. No product-quality claim or default-model selection follows.', 'rows': rows}
a.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'rows'}))
