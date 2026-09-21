"""Create a compact, claim-limited JSON artifact for the existing lab UI."""
import json
from pathlib import Path
import statistics
from prepare import HERE
from audit_release import audit, expected_inputs, training_valid


def read(name):
    path = HERE / name
    return json.loads(path.read_text()) if path.exists() else None


def summarize(recipes, split):
    if not recipes:
        return None
    datasets = sorted(set().union(*(r['splits'][split]['datasets'] for r in recipes)))
    fields = ['nll', 'accuracy', 'brier', 'ece', 'ordinalMae', 'coverage']
    output = {'macroNllMean': statistics.mean(r['splits'][split]['macroNll'] for r in recipes), 'datasets': {}}
    for dataset in datasets:
        values = [r['splits'][split]['datasets'][dataset] for r in recipes]
        output['datasets'][dataset] = {'total': values[0]['total'], 'supported': min(v['supported'] for v in values), **{field + 'Mean': statistics.mean(v[field] for v in values if field in v) for field in fields if any(field in v for v in values)}}
    overall = [r['splits'][split]['overall'] for r in recipes]
    output['overall'] = {'total': overall[0]['total'], 'supported': min(v['supported'] for v in overall), **{field + 'Mean': statistics.mean(v[field] for v in overall if field in v) for field in fields if any(field in v for v in overall)}}
    return output


models = []
expected = expected_inputs(HERE)
current_release = audit(HERE)
(HERE / 'release-status.json').write_text(json.dumps(current_release, indent=2) + '\n')
for identifier, label in [('laya', 'Laya residual scorer'), ('smol', 'SmolLM2-360M typed readout'), ('qwen', 'Qwen3-0.6B typed readout')]:
    result = read(f'results-{identifier}.json') or {}
    if result and not training_valid(result, identifier, expected):
        raise ValueError('Refusing invalid or stale training publication: ' + identifier)
    recipes = result.get('recipes', [])
    exported = read(f'export-{identifier}-17.json')
    models.append({'id': identifier, 'label': label, 'revision': result.get('revision'), 'training': {'status': 'complete' if recipes else 'pending', 'seeds': [r['seed'] for r in recipes], 'selected': result.get('selected'), 'trainableParameters': result.get('trainableParameters'), 'trainingSeconds': result.get('trainingSeconds'), 'selectionData': 'validation only'}, 'validation': summarize(recipes, 'validation'), 'test': summarize(recipes, 'test'), 'transfer': summarize(recipes, 'transfer'), 'frozenBaselines': read(f'frozen-baselines-{identifier}.json'), 'export': exported or {'status': 'pending', 'passed': False}, 'robustness': read(f'robustness-{identifier}.json'), 'evidence': [f'results-{identifier}.json', f'export-{identifier}-17.json', f'robustness-{identifier}.json'], 'limitations': ['Readout adapted on three datasets; backbone frozen.', 'Public benchmark exposure in backbone pretraining is not ruled out.'] + (['Upstream Laya documents BoolQ in its training mix.'] if identifier == 'laya' else [])})
    models[-1]['evidence'].extend(artifact['file'] for artifact in (exported or {}).get('decisionComparisonArtifacts', {}).values())
    models[-1]['inferencePrecision'] = 'MLX floating parameters use float32; Qwen retains four-bit packed weights with float32 scales/biases. Complete Core ML float32 graphs use dense weights and fixed 768-token padded inputs.'
report = {'schemaVersion': '1', 'status': 'experimental-study', 'title': 'Readouts adapted on three datasets', 'protocol': 'PROTOCOL.md', 'defaultModel': None, 'corpus': {'train': 768, 'validation': 192, 'test': 384, 'transferDecisions': 2384, 'typedDecisionsCases': 400}, 'models': models, 'baselines': read('baseline-results.json'), 'release': read('release-status.json'), 'evidence': {'protocol': 'PROTOCOL.md', 'sources': 'sources.json', 'corpusManifest': 'corpus-manifest.json', 'upstreamExposure': 'PROVENANCE.md', 'reviewDisposition': 'REVIEW-DISPOSITION.md'}, 'limitations': ['BANKING77/CLINC candidate tasks, STS-B ordinal scores and MultiRC answer validation are derivatives, not original full benchmark scores.', 'Same validation sample selects recipe, temperature and eventual default; test/transfer rows do not select them.', 'Incomplete or failed exports do not satisfy the distributable runtime gate.']}
report['metricCorrection'] = read('metric-correction.json')
report['release'] = current_release
report['defaultModel'] = current_release['installedDefault']
report['defaultSelection'] = read('default-selection.json')
report['metricDefinitions'] = {'ece': 'Ten-bin top-label confidence calibration against membership in the soft-gold argmax set. This is not calibration against the full soft target distribution.', 'brier': 'Squared probability error against the full target distribution, including soft ordinal and Typed Decisions targets.'}
report['evidence']['metricCorrection'] = 'metric-correction.json'
(HERE / 'publication.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'modelsWithTraining': sum(bool(x['training']['seeds']) for x in models), 'defaultModel': report['defaultModel']}))
