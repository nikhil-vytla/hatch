#!/usr/bin/env python3
"""Records Laya on Decide's deck: every request in .cache/decide/requests.json, as Jev is sent.

Laya is the promoted local default (`laya-readout-experimental`), run through
roadmap/mac/jev_local.py's Runtime, loaded once and warm, as in record-one-box-laya.py:

- choice → v2 `choice`, each option's criterion as its description;
- yes/no → v2 `boolean`;
- 0–2 score → v2 `ordinal` 0..2 with the level texts appended to the prompt (v2 rejects level
  descriptions).

Rows use the gateway's wire format so src/decide/combine.ts reads them like Jev's. Append-only
and resumable.

  bun jev-experiments/packages/arena/scripts/decide-export.ts
  jev-experiments/.venv/bin/python jev-experiments/packages/arena/scripts/record-decide-laya.py
"""
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]  # jev-experiments
OUT = ROOT / 'packages/arena/recordings/decide.laya.jsonl'
MODEL = 'laya-readout-experimental'

spec = importlib.util.spec_from_file_location('jev_local', ROOT / 'roadmap/mac/jev_local.py')
jev_local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev_local)


def v2(qid, q):
    if q['type'] == 'choice':
        return {'id': qid, 'kind': 'choice', 'prompt': q['instructions'],
                'options': [{'id': k, 'label': k.replace('_', ' '), 'description': v} for k, v in q['criteria'].items()]}
    if q['type'] == 'noul':
        return {'id': qid, 'kind': 'boolean', 'prompt': q['instructions']}
    levels = '; '.join(f'{i} = {text}' for i, text in enumerate(q['criteria']))
    return {'id': qid, 'kind': 'ordinal', 'prompt': f"{q['instructions']} ({levels})", 'min': 0, 'max': len(q['criteria']) - 1, 'step': 1}


def wire(q, decision):
    p = {str(d['value']).lower() if isinstance(d['value'], bool) else str(d['value']): d['probability'] for d in decision['distribution']}
    if q['type'] == 'noul':
        return {'type': 'noul', 'value': p['true'], 'probabilities': None, 'confidence': None}
    if q['type'] == 'score':
        levels = {str(int(float(k))): v for k, v in p.items()}
        return {'type': 'score', 'value': sum(int(k) * v for k, v in levels.items()), 'probabilities': levels, 'confidence': max(levels.values())}
    top = max(p, key=p.get)
    return {'type': 'choice', 'value': top, 'probabilities': p, 'confidence': p[top]}


def main():
    requests = json.loads((ROOT / '.cache/decide/requests.json').read_text())
    done = set()
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            row = json.loads(line)
            if row.get('status') == 'ok':
                done.add(row['id'])
    runtime = jev_local.Runtime(MODEL, ROOT / '.cache' / 'jev-local')
    runtime.decide({'schemaVersion': '2', 'requestId': 'warm', 'state': {}, 'questions': [{'id': 'w', 'kind': 'boolean', 'prompt': 'warm up'}]})
    with OUT.open('a') as out:
        for rid, req in requests.items():
            if rid in done:
                continue
            at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            started = time.perf_counter()
            try:
                result = runtime.decide({'schemaVersion': '2', 'requestId': rid, 'state': req['state'],
                                         'questions': [v2(qid, q) for qid, q in req['questions'].items()]})
                if result['status'] != 'ok':
                    raise RuntimeError(json.dumps(result['issues']))
                by = {d['questionId']: d for d in result['decisions']}
                answers = {qid: wire(q, by[qid]) for qid, q in req['questions'].items()}
                row = {'id': rid, 'at': at, 'status': 'ok', 'latencyMs': round((time.perf_counter() - started) * 1000, 1),
                       'model': runtime.spec['model'], 'revision': runtime.spec['revision'], 'answers': answers}
            except Exception as error:  # logged, never hidden; a rerun asks again
                row = {'id': rid, 'at': at, 'status': 'error', 'message': str(error)}
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
            out.flush()
    print('Done.', flush=True)


if __name__ == '__main__':
    sys.exit(main())
