"""Verify the pinned mirror's fluency labels against official expert annotations."""
import hashlib
import json
from pathlib import Path
import urllib.request
import pyarrow.parquet as pq
from prepare import DEFAULT_CACHE, HERE

url = 'https://storage.googleapis.com/sfr-summarization-repo-research/model_annotations.aligned.jsonl'
expected_sha = 'f0d4166e0cdeb439b387c4449634b067b7e9f721b9ef4c2b722f6b7550d3d6ab'
cache = DEFAULT_CACHE / 'source/summeval'
source = cache / 'official-model-annotations.jsonl'
if not source.exists():
    source.write_bytes(urllib.request.urlopen(url, timeout=90).read())
actual_sha = hashlib.sha256(source.read_bytes()).hexdigest()
if actual_sha != expected_sha:
    raise ValueError('Official annotation file changed; refusing unpinned verification')
annotations = [json.loads(x) for x in source.read_text().splitlines()]
mirror = pq.read_table(next(cache.rglob('*.parquet'))).to_pylist()
normalize = lambda text: ' '.join(text.split())
lookup = {}
for row in annotations:
    lookup.setdefault(normalize(row['decoded']), []).append(sum(x['fluency'] for x in row['expert_annotations']) / len(row['expert_annotations']))
checks = []
for i, row in enumerate(mirror):
    for j, summary in enumerate(row['machine_summaries']):
        expected = lookup.get(normalize(summary), [])
        checks.append({'id': f'{i}/{j}', 'matchedOfficialSummary': bool(expected), 'matchesMeanExpertFluency': any(abs(x - row['fluency'][j]) < 1e-8 for x in expected)})
report = {'source': url, 'sha256': actual_sha, 'sourceRows': len(annotations), 'mirrorRowsCompared': len(checks), 'summaryMatches': sum(x['matchedOfficialSummary'] for x in checks), 'meanExpertFluencyMatches': sum(x['matchesMeanExpertFluency'] for x in checks), 'failed': [x for x in checks if not x['matchesMeanExpertFluency']]}
(HERE / 'summeval-provenance-check.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
if report['failed']: raise SystemExit(1)
