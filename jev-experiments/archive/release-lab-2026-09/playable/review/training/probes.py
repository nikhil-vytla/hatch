"""Independent CPU-only evidence audit. Never imports MLX or loads a model.

Temporary copies of Jev's own JSON reports isolate the release/publication probe.
The output contains aggregates and hashes, not downloaded corpus text.
"""
from collections import Counter
import contextlib
import io
import json
import math
from pathlib import Path
import runpy
import sys
import tempfile

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parents[2] / 'training'
sys.path.insert(0, str(TRAINING))
import prepare
import study


def read(name):
    return json.loads((TRAINING / name).read_text())


def metric_probe():
    row = {'id': 'fixture', 'dataset': 'fixture', 'question': {'kind': 'ordinal'},
           'values': [0, 1], 'target': [.5, .5], 'status': 'ok', 'probabilities': [.5, .5]}
    unsupported = {**row, 'status': 'unsupported', 'reason': 'input limit'}
    perfect = study.metrics([row])
    return {'predictionExactlyMatchesSoftGold': perfect,
            'allUnsupported': study.grouped_metrics([unsupported])}


def gate_probe():
    """Real audit and publisher executed against isolated malformed evidence."""
    original_here = prepare.HERE
    original_audit = sys.modules.get('audit_release')
    with tempfile.TemporaryDirectory(prefix='jev-study-audit-') as temporary:
        fixture = Path(temporary)
        for name in ['PROTOCOL.md', 'corpus-manifest.json', 'models-manifest.json', 'sources.json',
                     'metric-correction.json', 'baseline-results.json']:
            (fixture / name).write_bytes((TRAINING / name).read_bytes())
        for name in study.MODELS:
            result = read(f'results-{name}.json')
            result.update(corpusSha256='stale-corpus', revision='wrong-revision')
            (fixture / f'results-{name}.json').write_text(json.dumps(result))
            export = {'model': 'wrong-model', 'seed': 999, 'status': 'complete',
                      'completeGraph': True, 'passed': True, 'pilotLimit': 0,
                      'evaluations': {'CPU_ONLY': {}, 'ALL': {}}}
            (fixture / f'export-{name}-17.json').write_text(json.dumps(export))
            (fixture / f'robustness-{name}.json').write_text(json.dumps({
                'optionOrder': {'wrong-a': {}, 'wrong-b': {}, 'wrong-c': {}},
                'batchIndependence': {}}))
            (fixture / f'frozen-baselines-{name}.json').write_text('{}')
        prepare.HERE = fixture
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(TRAINING / 'audit_release.py'), run_name='__main__')
            status = json.loads((fixture / 'release-status.json').read_text())
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(TRAINING / 'publish.py'), run_name='__main__')
                publication = json.loads((fixture / 'publication.json').read_text())
                published = {'accepted': True,
                             'researchEvidenceComplete': publication['release']['researchEvidenceComplete'],
                             'revisions': [x['revision'] for x in publication['models']]}
            except (Exception, SystemExit) as error:
                published = {'accepted': False, 'errorType': type(error).__name__, 'message': str(error)}
            # Publishing by itself must not trust a completion flag from an
            # earlier run after its underlying export/robustness files change.
            for name in study.MODELS:
                (fixture / f'results-{name}.json').write_text(json.dumps(read(f'results-{name}.json')))
            stale_status = {**status, 'researchEvidenceComplete': True}
            (fixture / 'release-status.json').write_text(json.dumps(stale_status))
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(TRAINING / 'publish.py'), run_name='__main__')
                public = json.loads((fixture / 'publication.json').read_text())
                stale_publication = {'accepted': True, 'researchEvidenceComplete': public['release']['researchEvidenceComplete']}
            except (Exception, SystemExit) as error:
                stale_publication = {'accepted': False, 'errorType': type(error).__name__, 'message': str(error)}
            return {'mutations': ['stale result corpus hash', 'wrong backbone revision',
                                  'wrong export identity and seed', 'empty export comparisons',
                                  'empty baseline object', 'wrong robustness seeds and empty batch checks'],
                    'release': status, 'publication': published, 'staleReleasePublication': stale_publication}
        except (Exception, SystemExit) as error:
            return {'rejected': True, 'errorType': type(error).__name__, 'message': str(error)}
        finally:
            prepare.HERE = original_here
            if original_audit is None:
                sys.modules.pop('audit_release', None)
            else:
                sys.modules['audit_release'] = original_audit


def selection_identity_probe():
    """The CLI must validate identity before using its pure ranking helper."""
    original_here = prepare.HERE
    original_audit = sys.modules.get('audit_release')
    with tempfile.TemporaryDirectory(prefix='jev-selection-audit-') as temporary:
        fixture = Path(temporary)
        for name in ['PROTOCOL.md', 'corpus-manifest.json', 'models-manifest.json']:
            (fixture / name).write_bytes((TRAINING / name).read_bytes())
        for name in study.MODELS:
            trained = read(f'results-{name}.json')
            (fixture / f'results-{name}.json').write_text(json.dumps(trained))
            validation = next(recipe for recipe in trained['recipes'] if recipe['seed'] == 17)['splits']['validation']
            condition = {'warmMedianMs': 1, 'splits': {'validation': {
                'argmaxAgreement': 1, 'maxProbabilityDelta': 0,
                'decisionsCompared': validation['overall']['supported'],
                'metrics': validation}}}
            exported = {'status': 'complete', 'completeGraph': True, 'seed': 17,
                        'model': 'wrong-model', 'pilotLimit': 0,
                        'evaluations': {'CPU_ONLY': condition, 'ALL': condition}}
            (fixture / f'export-{name}-17.json').write_text(json.dumps(exported))
        prepare.HERE = fixture
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(TRAINING / 'select_default.py'), run_name='__main__')
            return json.loads((fixture / 'default-selection.json').read_text())
        finally:
            prepare.HERE = original_here
            if original_audit is None:
                sys.modules.pop('audit_release', None)
            else:
                sys.modules['audit_release'] = original_audit


def max_numeric_difference(left, right):
    if isinstance(left, dict):
        if set(left) != set(right):
            raise ValueError('Metric keys differ')
        return max((max_numeric_difference(v, right[k]) for k, v in left.items()), default=0)
    if isinstance(left, (int, float)) and not isinstance(left, bool):
        if not math.isfinite(left) or not math.isfinite(right):
            raise ValueError('Nonfinite metric')
        return abs(left - right)
    if left != right:
        raise ValueError('Metric value differs')
    return 0


def current_evidence_probe():
    manifest = read('corpus-manifest.json')
    rows = {split: study.read_rows(prepare.DEFAULT_CACHE, split) for split in manifest['splits']}
    source_identity = {}
    cross_split_duplicates = []
    for split, records in rows.items():
        for record in records:
            identity = prepare.content_identity(record)
            if identity in source_identity and source_identity[identity] != split:
                cross_split_duplicates.append([source_identity[identity], split])
            source_identity[identity] = split
    invalid_targets = sum(any(not math.isfinite(v) or v < 0 for v in row['target'])
                          or abs(sum(row['target']) - 1) > 1e-9
                          for records in rows.values() for row in records)
    models = {}
    for name in study.MODELS:
        result = read(f'results-{name}.json')
        selection = min(result['search'], key=lambda x: (x['macroValidationNll'], x['learningRate'], x['epoch']))
        comparisons = []
        for recipe in result['recipes']:
            calibration = min(recipe['temperatureCandidates'], key=lambda x: x['macroValidationNll'])
            for split in ['validation', 'test', 'transfer']:
                path = prepare.DEFAULT_CACHE / name / f'predictions-{recipe["seed"]}-{split}.jsonl'
                predictions = [json.loads(line) for line in path.read_text().splitlines()]
                aligned = len(predictions) == len(rows[split]) and all(
                    all(prediction.get(key) == value for key, value in row.items())
                    for row, prediction in zip(rows[split], predictions))
                comparisons.append({'seed': recipe['seed'], 'split': split, 'rows': len(predictions),
                                    'predictionSha256': study.file_digest(path),
                                    'alignedWithFrozenRows': aligned,
                                    'maximumRecomputedMetricDelta': max_numeric_difference(
                                        study.grouped_metrics(predictions), recipe['splits'][split]),
                                    'calibrationMatchesValidationMinimum': calibration == recipe['calibration']})
        models[name] = {'protocolMatches': result['protocolSha256'] == study.file_digest(TRAINING / 'PROTOCOL.md'),
                        'corpusMatches': result['corpusSha256'] == study.file_digest(TRAINING / 'corpus-manifest.json'),
                        'revisionMatches': result['revision'] == study.MODELS[name]['revision'],
                        'selectionMatchesValidationMinimum': selection == result['selected'],
                        'comparisons': comparisons}
    return {'counts': {split: len(records) for split, records in rows.items()},
            'datasetCounts': {split: dict(Counter(row['dataset'] for row in records)) for split, records in rows.items()},
            'typedDecisionsCases': len({row['caseId'] for row in rows['transfer'] if 'caseId' in row}),
            'invalidTargets': invalid_targets, 'crossSplitExactTaskDuplicates': len(cross_split_duplicates),
            'sourcesManifestMatches': manifest['sourcesSha256'] == study.file_digest(TRAINING / 'sources.json'),
            'models': models}


if __name__ == '__main__':
    result = {'scope': 'CPU and provider free; no model loading, downloads or GPU',
              'sourceHashes': {name: study.file_digest(TRAINING / name) for name in
                               ['study.py', 'audit_release.py', 'publish.py', 'robustness.py', 'export_coreml.py',
                                'select_default.py', 'evidence.py'] if (TRAINING / name).exists()},
              'metrics': metric_probe(), 'malformedEvidenceGate': gate_probe(),
              'currentEvidence': current_evidence_probe()}
    if (TRAINING / 'select_default.py').exists():
        result['selectionRejectsWrongIdentity'] = selection_identity_probe()
    destination = HERE / (sys.argv[1] if len(sys.argv) > 1 else 'probe-results.json')
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(destination), 'malformedEvidenceGate': result['malformedEvidenceGate'],
                      'metrics': result['metrics'], 'currentCorpusCounts': result['currentEvidence']['counts']}, indent=2))
