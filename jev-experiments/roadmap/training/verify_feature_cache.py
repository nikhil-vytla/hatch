"""Audit completed extraction files and seal integrity hashes without refitting.

This can upgrade an earlier v1 manifest only when its original model revision
and original corpus hash already match. It never relabels a stale corpus.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from prepare import HERE, DEFAULT_CACHE, digest
from study import MODELS, file_digest, read_rows, variant, verify_weights

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', required=True, choices=list(MODELS))
parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
args = parser.parse_args()
location = args.cache / args.model
path = location / 'feature-manifest.json'
manifest = json.loads(path.read_text())
if manifest['corpusSha256'] != digest((HERE / 'corpus-manifest.json').read_bytes()) or manifest['revision'] != MODELS[args.model]['revision']:
    raise ValueError('Refusing stale corpus/model provenance')
verify_weights(args.model)
checks = {}
for split in ['train', 'validation', 'test', 'transfer']:
    rows = read_rows(args.cache, split)
    expected = [variant(row, epoch) for epoch in range(3) for row in rows] if split == 'train' else rows
    metadata = json.loads((location / f'{split}.json').read_text())
    arrays = np.load(location / f'{split}.npz')
    if len(metadata) != len(expected) or arrays['features'].shape[0] != len(expected):
        raise ValueError('Unexpected feature row count')
    for i, (item, record) in enumerate(zip(expected, metadata)):
        if item['id'] != record['id'] or item['values'] != record['values']:
            raise ValueError('Feature metadata identity mismatch')
        if not np.allclose(arrays['targets'][i, :len(item['values'])], item['target'], rtol=0, atol=1e-7):
            raise ValueError('Feature target mismatch')
    checks[split] = {'rows': len(expected), 'arraysSha256': file_digest(location / f'{split}.npz'), 'metadataSha256': file_digest(location / f'{split}.json')}
manifest.update(status='complete', modelFilesSha256=digest((HERE / 'models-manifest.json').read_bytes()), splits=checks)
path.write_text(json.dumps(manifest, indent=2) + '\n')
(HERE / f'cache-verification-{args.model}.json').write_text(json.dumps({'model': args.model, 'originalCorpusAndRevisionMatched': True, 'allBackboneFileHashesMatched': True, 'allTargetAndMetadataRowsMatched': True, 'featureManifestSha256': file_digest(path), 'splits': checks}, indent=2) + '\n')
print(json.dumps({'model': args.model, 'verifiedRows': sum(x['rows'] for x in checks.values())}))
