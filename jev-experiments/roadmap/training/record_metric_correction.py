"""Record the post-freeze soft-gold argmax implementation correction transparently."""
from datetime import datetime, timezone
import json
from prepare import HERE, DEFAULT_CACHE, digest
from study import metrics

path = HERE / 'metric-correction.json'
previous = json.loads(path.read_text()) if path.exists() else {}
changes = []
for seed in [17, 29, 43]:
    for split in ['validation', 'test', 'transfer']:
        predictions = DEFAULT_CACHE / 'laya' / f'predictions-{seed}-{split}.jsonl'
        if not predictions.exists():
            continue
        rows = [json.loads(line) for line in predictions.read_text().splitlines()]
        good = [row for row in rows if row['status'] == 'ok']
        bins = [[] for _ in range(10)]
        hits = []
        for row in good:
            p, target = row['probabilities'], row['target']
            winner = max(range(len(p)), key=p.__getitem__)
            gold = max(range(len(target)), key=target.__getitem__)
            hit = float(winner == gold)
            hits.append(hit)
            bins[min(9, int(p[winner] * 10))].append((p[winner], hit))
        current = metrics(rows)
        changes.append({'model': 'laya', 'seed': seed, 'split': split, 'predictionFileSha256': digest(predictions.read_bytes()), 'oldAccuracy': sum(hits) / len(hits), 'correctedAccuracy': current['accuracy'], 'oldEce': sum(abs(sum(a - b for a, b in group)) for group in bins) / len(good), 'correctedEce': current['ece']})
report = {'recordedAt': previous.get('recordedAt', datetime.now(timezone.utc).isoformat()), 'protocolSha256': digest((HERE / 'PROTOCOL.md').read_bytes()), 'protocolWasChanged': False, 'classification': 'Implementation correction after protocol freeze and after Laya fitting; Smol and Qwen fitting use the corrected implementation from their first reported run.', 'before': 'A prediction was correct only if it matched the first position in a tied soft-gold maximum.', 'after': 'A prediction is correct when its gold mass differs from the maximum gold mass by at most 1e-12, regardless of option position.', 'reason': 'A tied soft-gold argmax is a set. First-position tie breaking introduced arbitrary order dependence.', 'affectedMetrics': ['accuracy', 'expected calibration error'], 'unaffected': ['model predictions', 'negative log likelihood', 'Brier score', 'ordinal MAE', 'coverage', 'learning rate selection', 'epoch selection', 'temperature selection'], 'selectionImpact': 'None. Configuration and calibration use macro validation NLL exclusively. Saved predictions were aggregated again; no inference, fitting or checkpoint selection was rerun for this correction.', 'comparisons': changes}
path.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'comparisons': len(changes), 'protocolSha256': report['protocolSha256']}))
