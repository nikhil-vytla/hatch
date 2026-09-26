#!/usr/bin/env python3
"""Records Laya answering One box's 14 questions for every prefix Jev was asked.

Laya here is the promoted local default, `laya-readout-experimental` (roadmap/mac/models.json),
run through roadmap/mac/jev_local.py's Runtime, loaded once and kept warm. State is `{"text":
prefix}`, as Jev saw it. Protocol fixed before running:

- Choice questions go as v2 `choice` with each option's criteria text as its description.
- Yes/no questions go as v2 `boolean`, with no criteria (the questions have none).
- The two 0-2 scores go as v2 `ordinal` 0..2. The v2 runtime rejects level descriptions, so
  the level texts are appended to the prompt ("0 = ...; 1 = ...; 2 = ...").
- `intent` has 20 options and Laya accepts at most 8. As a workaround, not Laya's native
  behaviour, the options are split in question order into groups of 7, 7 and 6, each group is
  asked on its own, then a final choice is asked between the three group winners:
  p(option) = p(option | its group) x p(its group's winner in the final), renormalised.
  So each prefix is two local requests: the 13 other questions plus the 3 groups, then the final.

Output rows use the gateway's wire format so src/one-box/adapter.ts parses them. latencyMs is
the wall time of both requests, warm. The log is append-only and resumable; the machine,
versions and model revision go to one-box.laya.meta.json.

  bun jev-experiments/packages/arena/scripts/one-box-export.ts
  jev-experiments/.venv/bin/python jev-experiments/packages/arena/scripts/record-one-box-laya.py
"""
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]  # jev-experiments
CACHE = ROOT / '.cache'
OUT = ROOT / 'packages/arena/recordings/one-box.laya.jsonl'
META = ROOT / 'packages/arena/recordings/one-box.laya.meta.json'
MODEL = 'laya-readout-experimental'
GROUPS = [7, 7, 6]

spec = importlib.util.spec_from_file_location('jev_local', ROOT / 'roadmap/mac/jev_local.py')
jev_local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev_local)

questions = json.loads((CACHE / 'one-box/questions.json').read_text())
keys = json.loads((CACHE / 'one-box/keys.json').read_text())


def choice(qid, prompt, criteria):
    return {'id': qid, 'kind': 'choice', 'prompt': prompt,
            'options': [{'id': k, 'label': k.replace('_', ' '), 'description': v} for k, v in criteria.items()]}


def v2(qid, q):
    if q['type'] == 'choice':
        return choice(qid, q['instructions'], q['criteria'])
    if q['type'] == 'noul':
        return {'id': qid, 'kind': 'boolean', 'prompt': q['instructions']}
    levels = '; '.join(f'{i} = {text}' for i, text in enumerate(q['criteria']))
    return {'id': qid, 'kind': 'ordinal', 'prompt': f"{q['instructions']} ({levels})", 'min': 0, 'max': len(q['criteria']) - 1, 'step': 1}


intent = questions['intent']
intent_items = list(intent['criteria'].items())
groups, start = [], 0
for size in GROUPS:
    groups.append(dict(intent_items[start:start + size]))
    start += size
assert start == len(intent_items), 'the intent groups must cover every option'

FIRST = [v2(qid, q) for qid, q in questions.items() if qid != 'intent']
FIRST += [choice(f'intent_group_{i}', intent['instructions'], g) for i, g in enumerate(groups)]


def distribution(decision):
    return {str(d['value']).lower() if isinstance(d['value'], bool) else str(d['value']): d['probability'] for d in decision['distribution']}


def wire(q, decision):
    p = distribution(decision)
    if q['type'] == 'noul':
        return {'type': 'noul', 'value': p['true'], 'probabilities': p, 'confidence': max(p.values())}
    if q['type'] == 'score':
        return {'type': 'score', 'value': decision['expected'], 'probabilities': {str(int(float(k))): v for k, v in p.items()}, 'confidence': max(p.values())}
    top = max(p, key=p.get)
    return {'type': 'choice', 'value': top, 'probabilities': p, 'confidence': p[top]}


def ask(runtime, request_id, state, qs):
    result = runtime.decide({'schemaVersion': '2', 'requestId': request_id, 'state': state, 'questions': qs})
    if result['status'] != 'ok':
        raise RuntimeError(json.dumps(result['issues']))
    return {d['questionId']: d for d in result['decisions']}


def answer(runtime, key):
    state = {'text': key}
    first = ask(runtime, f'{key}#1', state, FIRST)
    winners = [first[f'intent_group_{i}']['selected'] for i in range(len(groups))]
    final_criteria = {w: intent['criteria'][w] for w in winners}
    final = distribution(ask(runtime, f'{key}#2', state, [choice('intent_final', intent['instructions'], final_criteria)])['intent_final'])
    p = {}
    for i, g in enumerate(groups):
        within = distribution(first[f'intent_group_{i}'])
        for option in g:
            p[option] = within[option] * final[winners[i]]
    total = sum(p.values()) or 1
    p = {k: v / total for k, v in p.items()}
    top = max(p, key=p.get)
    answers = {'intent': {'type': 'choice', 'value': top, 'probabilities': p, 'confidence': p[top]}}
    for qid, q in questions.items():
        if qid != 'intent':
            answers[qid] = wire(q, first[qid])
    return answers


def sysctl(name):
    return subprocess.run(['sysctl', '-n', name], capture_output=True, text=True).stdout.strip()


def main():
    import mlx.core
    import numpy
    import tokenizers

    done = set()
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            row = json.loads(line)
            if row.get('status') == 'ok':
                done.add(row['key'])
    todo = [k for k in keys if k not in done]

    runtime = jev_local.Runtime(MODEL, CACHE / 'jev-local')
    answer(runtime, 'warm up')  # the first pass compiles kernels; never timed
    META.write_text(json.dumps({
        'model': MODEL, 'modelId': runtime.spec['model'], 'revision': runtime.spec['revision'],
        'baseModel': runtime.spec['baseModel'], 'baseRevision': runtime.spec['baseRevision'],
        'readout': runtime.spec['readout'], 'loadMs': runtime.load_ms,
        'machine': {'chip': sysctl('machdep.cpu.brand_string'), 'memoryGiB': int(sysctl('hw.memsize')) / 2**30, 'platform': platform.platform()},
        'versions': {'python': platform.python_version(), 'mlx': mlx.core.__version__, 'numpy': numpy.__version__, 'tokenizers': tokenizers.__version__},
        'intentGroups': [list(g) for g in groups],
        'notes': 'intent asked as three groups (7/7/6) then a final choice between group winners, because Laya accepts at most 8 options; score level texts appended to the prompt because v2 rejects level descriptions.',
    }, indent=1) + '\n')

    print(f'{len(keys)} prefixes, {len(done)} recorded, {len(todo)} to ask.', flush=True)
    with OUT.open('a') as out:
        for n, key in enumerate(todo, 1):
            at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            started = time.perf_counter()
            try:
                answers = answer(runtime, key)
                row = {'key': key, 'at': at, 'status': 'ok', 'latencyMs': round((time.perf_counter() - started) * 1000, 1), 'model': MODEL, 'answers': answers}
            except Exception as error:  # logged, never hidden; a rerun asks again
                row = {'key': key, 'at': at, 'status': 'error', 'message': str(error)}
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
            out.flush()
            if n % 200 == 0:
                print(f'{n} / {len(todo)}', flush=True)
    print('Done.', flush=True)


if __name__ == '__main__':
    sys.exit(main())
