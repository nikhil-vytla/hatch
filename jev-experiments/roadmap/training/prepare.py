"""Download pinned data and freeze a small, explicit typed-decision derivative.

Downloaded text belongs in the ignored cache. The committed manifest contains
IDs and hashes, not copies of the source corpus. No model is loaded here.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import random
import urllib.request

HERE = Path(__file__).resolve().parent
LAB = HERE.parents[1]
DEFAULT_CACHE = LAB / '.cache' / 'typed-study-v1'
SOURCES = {
    'banking77': {'repo': 'PolyAI-LDN/task-specific-datasets', 'revision': '57ec275d8078af65b7731c2a98be812d844a6d6b', 'host': 'github', 'files': ['banking_data/categories.json', 'banking_data/train.csv', 'banking_data/test.csv']},
    'boolq': {'repo': 'google/boolq', 'revision': '35b264d03638db9f4ce671b711558bf7ff0f80d5', 'host': 'hf', 'files': ['data/train-00000-of-00001.parquet', 'data/validation-00000-of-00001.parquet']},
    'stsb': {'repo': 'sentence-transformers/stsb', 'revision': 'ab7a5ac0e35aa22088bdcf23e7fd99b220e53308', 'host': 'hf', 'files': ['data/train-00000-of-00001.parquet', 'data/validation-00000-of-00001.parquet', 'data/test-00000-of-00001.parquet']},
    'clinc': {'repo': 'clinc/oos-eval', 'revision': '828f8093932c8fe6ca7936c3d2e52903b1c523de', 'host': 'github', 'files': ['data/data_full.json']},
    'multirc': {'repo': 'aps/super_glue', 'revision': '3de24cf8022e94f4ee4b9d55a6f539891524d646', 'host': 'hf', 'files': ['multirc/validation-00000-of-00001.parquet']},
    'summeval': {'repo': 'mteb/summeval', 'revision': 'bfc121155064afa2d81b5505682ffc0d96f4334c', 'host': 'hf', 'files': ['data/test-00000-of-00001-35901af5f6649399.parquet']},
    'typed_decisions': {'repo': 'LocalLLaMA/typed-decisions', 'revision': 'ea9306458d6e9563628369a3d1e72e362fb381d2', 'host': 'hf', 'files': ['all/test-00000-of-00001.parquet']},
}
INSTRUCTIONS = {
    'choice': ['Choose the candidate that best describes the request.', 'Which listed intent matches the supplied request?', 'Classify the request using one of the supplied candidates.'],
    'boolean': ['Decide whether the question is answered yes by the passage.', 'Using the passage, answer the supplied question as true or false.', 'Determine whether the passage supports a yes answer.'],
    'ordinal': ['Rate how similar the two sentences are in meaning, from 0 to 5.', 'Estimate semantic similarity: 0 means unrelated; 5 means equivalent.', 'Choose the meaning similarity level between unrelated (0) and equivalent (5).'],
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def ranking(dataset, source_id):
    return digest('jev-typed-v1:' + dataset + ':' + str(source_id))


def fetch(cache, dataset, spec, path):
    target = cache / 'source' / dataset / path
    url = (f"https://raw.githubusercontent.com/{spec['repo']}/{spec['revision']}/{path}" if spec['host'] == 'github' else f"https://huggingface.co/datasets/{spec['repo']}/resolve/{spec['revision']}/{path}")
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=90) as response:
            target.write_bytes(response.read())
    return target, {'url': url, 'sha256': digest(target.read_bytes()), 'bytes': target.stat().st_size}


def ordinal_target(score, low, high):
    if not low <= score <= high:
        raise ValueError('Ordinal target outside declared scale')
    return [max(0.0, 1.0 - abs(score - x)) for x in range(low, high + 1)]


def choice(dataset, sid, text, target, labels):
    others = sorted(set(labels) - {target}, key=lambda x: ranking(dataset, sid + ':' + x))[:7]
    opts = sorted([target] + others, key=lambda x: ranking(dataset, sid + ':order:' + x))
    return {'id': f'{dataset}/{sid}', 'dataset': dataset, 'state': text,
            'question': {'id': 'decision', 'kind': 'choice', 'prompt': INSTRUCTIONS['choice'][0], 'options': [{'id': x, 'label': x.replace('_', ' ')} for x in opts]},
            'values': opts, 'target': [float(x == target) for x in opts], 'derivative': 'eight-candidate intent selection'}


def bool_row(dataset, sid, state, question, answer):
    return {'id': f'{dataset}/{sid}', 'dataset': dataset, 'state': state,
            'question': {'id': 'decision', 'kind': 'boolean', 'prompt': question}, 'values': [False, True], 'target': [float(not answer), float(bool(answer))]}


def ordinal_row(dataset, sid, state, prompt, score, low=0, high=5):
    return {'id': f'{dataset}/{sid}', 'dataset': dataset, 'state': state,
            'question': {'id': 'decision', 'kind': 'ordinal', 'prompt': prompt, 'min': low, 'max': high},
            'values': list(range(low, high + 1)), 'target': ordinal_target(score, low, high), 'originalScore': score, 'derivative': 'linearly interpolated ordinal rating'}


def ordered(rows, dataset):
    return sorted(rows, key=lambda r: ranking(dataset, r['id'].removeprefix(dataset + '/')))


def make_corpus(cache, paths):
    import pyarrow.parquet as pq
    read = lambda d, p: pq.read_table(paths[d][p]).to_pylist()
    splits = {'train': [], 'validation': [], 'test': [], 'transfer': []}
    labels = json.loads(paths['banking77']['banking_data/categories.json'].read_text())
    for source in ['train', 'test']:
        raw = list(csv.DictReader(io.StringIO(paths['banking77'][f'banking_data/{source}.csv'].read_text())))
        rows = ordered([choice('banking77', f'{source}/{i}', r['text'], r['category'], labels) for i, r in enumerate(raw)], 'banking77')
        if source == 'train':
            splits['train'] += rows[:256]
            splits['validation'] += rows[256:320]
        else:
            splits['test'] += rows[:128]
    for source in ['train', 'validation']:
        raw = read('boolq', f'data/{source}-00000-of-00001.parquet')
        rows = ordered([bool_row('boolq', f'{source}/{i}', r['passage'], r['question'], r['answer']) for i, r in enumerate(raw)], 'boolq')
        if source == 'train':
            splits['train'] += rows[:256]
            splits['validation'] += rows[256:320]
        else:
            splits['test'] += rows[:128]
    for source, count in [('train', 256), ('validation', 64), ('test', 128)]:
        raw = read('stsb', f'data/{source}-00000-of-00001.parquet')
        rows = [ordinal_row('stsb', f'{source}/{i}', {'sentence1': r['sentence1'], 'sentence2': r['sentence2']}, INSTRUCTIONS['ordinal'][0], float(r['score']) * 5) for i, r in enumerate(raw)]
        splits[source] += ordered(rows, 'stsb')[:count]
    raw = json.loads(paths['clinc']['data/data_full.json'].read_text())
    labels = sorted({r[1] for r in raw['train']})
    splits['transfer'] += ordered([choice('clinc', f'test/{i}', r[0], r[1], labels) for i, r in enumerate(raw['test'])], 'clinc')[:128]
    raw = read('multirc', 'multirc/validation-00000-of-00001.parquet')
    splits['transfer'] += ordered([bool_row('multirc', f'validation/{i}', {'paragraph': r['paragraph'], 'question': r['question'], 'proposedAnswer': r['answer']}, 'Is the proposed answer correct given the paragraph and question?', r['label']) for i, r in enumerate(raw)], 'multirc')[:128]
    raw = read('summeval', 'data/test-00000-of-00001-35901af5f6649399.parquet')
    rows = []
    for i, r in enumerate(raw):
        for j, summary in enumerate(r['machine_summaries']):
            row = ordinal_row('summeval', f'test/{i}/{j}', {'summary': summary}, 'Rate the fluency of the system summary from 1 (poor) to 5 (excellent). Judge grammar and readability.', float(r['fluency'][j]), 1, 5)
            row['sourceDocumentSha256'] = digest(r['text'])
            row['referenceCount'] = len(r['human_summaries'])
            rows.append(row)
    splits['transfer'] += ordered(rows, 'summeval')[:128]
    raw = read('typed_decisions', 'all/test-00000-of-00001.parquet')
    if len(raw) != 400:
        raise ValueError(f'Expected all 400 Typed Decisions cases, got {len(raw)}')
    for r in raw:
        state, questions, gold = (json.loads(r[x]) for x in ['state', 'questions', 'gold'])
        for key, q in questions.items():
            kind = {'choice': 'choice', 'noul': 'boolean', 'score': 'ordinal'}[q['type']]
            nq = {'id': key, 'kind': kind, 'prompt': q['instructions']}
            if kind == 'choice':
                values = list(q['criteria'])
                nq['options'] = [{'id': k, 'label': v} for k, v in q['criteria'].items()]
            elif kind == 'boolean':
                values = [False, True]
                nq['prompt'] += '\n' + canonical(q.get('criteria', {}))
            else:
                values = list(range(len(q['criteria'])))
                nq.update(min=0, max=len(values) - 1)
                nq['prompt'] += '\nScale: ' + canonical(q['criteria'])
            target = [gold[key]['probabilities'][str(v).lower() if kind == 'boolean' else str(v)] for v in values]
            total = sum(target)
            splits['transfer'].append({'id': f'typed_decisions/{r["id"]}/{key}', 'caseId': r['id'], 'dataset': 'typed_decisions', 'state': state, 'question': nq, 'values': values, 'target': [x / total for x in target], 'workflow': r['workflow']})
    return splits


def content_identity(row):
    """Exact task duplicates, independent of option order or source ID.

    A repeated passage alone is not duplicate question-answer evidence. STS-B
    sentence-pair identity is symmetric. Labels are never used in this key.
    """
    if row['dataset'] == 'stsb':
        task = sorted([row['state']['sentence1'], row['state']['sentence2']])
    elif row['question']['kind'] == 'choice':
        task = row['state']
    else:
        task = [row['state'], row['question']['prompt']]
    return digest(canonical([row['dataset'], task]))


def exclude_content_overlap(splits):
    seen, excluded = {}, []
    for split in ['transfer', 'test', 'validation', 'train']:
        kept = []
        for row in splits[split]:
            identity = content_identity(row)
            if identity in seen and seen[identity]['split'] != split:
                excluded.append({'id': row['id'], 'split': split, 'contentSha256': identity, 'kept': seen[identity]})
            else:
                kept.append(row)
                seen[identity] = {'id': row['id'], 'split': split}
        splits[split] = kept
    return excluded


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    p.add_argument('--manifest', type=Path, default=HERE / 'corpus-manifest.json')
    args = p.parse_args()
    paths, sources = {}, {}
    for dataset, spec in SOURCES.items():
        paths[dataset], sources[dataset] = {}, {**spec, 'files': {}}
        for path in spec['files']:
            local, info = fetch(args.cache, dataset, spec, path)
            paths[dataset][path] = local
            sources[dataset]['files'][path] = info
    source_path = HERE / 'sources.json'
    if source_path.exists() and json.loads(source_path.read_text()) != sources:
        raise ValueError('Pinned source bytes changed; refusing to overwrite sources.json')
    source_path.write_text(json.dumps(sources, indent=2) + '\n')
    splits = make_corpus(args.cache, paths)
    exclusions = exclude_content_overlap(splits)
    manifest = {'schemaVersion': '1', 'protocolSha256': digest((HERE / 'PROTOCOL.md').read_bytes()), 'sourcesSha256': digest(source_path.read_bytes()), 'crossSplitExclusions': exclusions, 'augmentation': {'instructions': INSTRUCTIONS, 'candidateForms': ['intent name with underscores replaced by spaces', 'The request concerns {intent name with underscores replaced by spaces}.'], 'optionPermutation': 'Python random.Random(jev-typed-v1:{row ID}:{epoch}).shuffle'}, 'splits': {}}
    seen = set()
    for split, rows in splits.items():
        for row in rows:
            if row['id'] in seen:
                raise ValueError('Repeated source ID across splits: ' + row['id'])
            seen.add(row['id'])
        content = ''.join(canonical(r) + '\n' for r in rows)
        (args.cache / f'{split}.jsonl').write_text(content)
        manifest['splits'][split] = {'count': len(rows), 'sha256': digest(content), 'rows': [{'id': r['id'], 'sha256': digest(canonical(r)), 'contentSha256': content_identity(r)} for r in rows]}
    if args.manifest.exists() and json.loads(args.manifest.read_text()) != manifest:
        raise ValueError('Frozen transformed corpus changed; use a new protocol version')
    args.manifest.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({s: x['count'] for s, x in manifest['splits'].items()}))

if __name__ == '__main__':
    main()
