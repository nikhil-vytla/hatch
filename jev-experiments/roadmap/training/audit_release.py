"""Derive gates from complete measurements and matching immutable provenance."""
import json
import math
import sys
from prepare import HERE, digest

SEEDS = {17, 29, 43}
SPLITS = ('validation', 'test', 'transfer')


def finite(value, minimum=0, maximum=float('inf')):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and minimum <= value <= maximum


def measurement(value, count):
    if not isinstance(value, dict) or count <= 0 or value.get('total') != count or not isinstance(value.get('supported'), int):
        return False
    supported = value['supported']
    if not 0 <= supported <= count or not finite(value.get('coverage'), 0, 1) or abs(value['coverage'] - supported / count) > 1e-9:
        return False
    if not isinstance(value.get('unsupportedReasons'), dict) or sum(value['unsupportedReasons'].values()) != count - supported:
        return False
    return not supported or all(finite(value.get(field), 0, 1 if field in ['accuracy', 'ece'] else float('inf')) for field in ['nll', 'accuracy', 'brier', 'ece'])


def grouped(value, count):
    if not isinstance(value, dict) or not measurement(value.get('overall'), count):
        return False
    for key in ['datasets', 'kinds']:
        groups = value.get(key, {})
        if not groups or sum(row.get('total', 0) for row in groups.values()) != count or not all(measurement(row, row.get('total', 0)) for row in groups.values()):
            return False
    nlls = [row['nll'] for row in value['datasets'].values() if row['supported']]
    return value.get('macroNll') is None if not nlls else finite(value.get('macroNll')) and abs(value['macroNll'] - sum(nlls) / len(nlls)) < 1e-9


def expected_inputs(root=HERE):
    corpus = json.loads((root / 'corpus-manifest.json').read_text())
    protocol_hash = digest((root / 'PROTOCOL.md').read_bytes())
    if corpus.get('protocolSha256') != protocol_hash or corpus.get('sourcesSha256') != digest((root / 'sources.json').read_bytes()):
        raise ValueError('Frozen corpus protocol/source bindings do not match current files')
    models = json.loads((root / 'models-manifest.json').read_text())
    checkpoint_path = root / 'checkpoints/manifest.json'
    checkpoints = json.loads(checkpoint_path.read_text()).get('files', {}) if checkpoint_path.exists() else {}
    return {'root': root, 'protocolSha256': protocol_hash, 'corpusSha256': digest((root / 'corpus-manifest.json').read_bytes()), 'modelFilesSha256': digest((root / 'models-manifest.json').read_bytes()), 'counts': {split: corpus['splits'][split]['count'] for split in SPLITS}, 'models': models, 'checkpoints': checkpoints}


def provenance_valid(document, name, expected, readouts=False):
    provenance = document.get('provenance', {})
    valid = provenance.get('model') == name and provenance.get('revision') == expected['models'][name]['revision'] and all(provenance.get(key) == expected[key] for key in ['protocolSha256', 'corpusSha256', 'modelFilesSha256']) and isinstance(provenance.get('featureManifestSha256'), str) and len(provenance['featureManifestSha256']) == 64
    if readouts:
        valid = valid and all(provenance.get('readoutSha256', {}).get(str(seed)) == expected['checkpoints'].get(f'{name}-{seed}.safetensors', {}).get('sha256') and provenance.get('readoutSha256', {}).get(str(seed)) is not None for seed in SEEDS)
    return valid


def training_valid(document, name, expected):
    recipes = document.get('recipes', [])
    if document.get('model') != name or document.get('revision') != expected['models'][name]['revision'] or any(document.get(key) != expected[key] for key in ['protocolSha256', 'corpusSha256']):
        return False
    if len(recipes) != 3 or {row.get('seed') for row in recipes} != SEEDS or document.get('trainingRuntime') != 'MLX':
        return False
    search = document.get('search', [])
    if len(search) != 4 or any(not finite(row.get('macroValidationNll')) or row.get('seed') != 17 for row in search) or {(row.get('learningRate'), row.get('epoch')) for row in search} != {(rate, epoch) for rate in [.0001, .001] for epoch in [1, 3]}:
        return False
    if document.get('selected') != min(search, key=lambda row: (row['macroValidationNll'], row['learningRate'], row['epoch'])):
        return False
    for recipe in recipes:
        if any(not grouped(recipe.get('splits', {}).get(split), expected['counts'][split]) for split in SPLITS):
            return False
        temperatures = recipe.get('temperatureCandidates', [])
        if len(temperatures) != 5 or {row.get('temperature') for row in temperatures} != {.7, 1, 1.3, 1.6, 2} or any(not finite(row.get('macroValidationNll')) for row in temperatures) or recipe.get('calibration') != min(temperatures, key=lambda row: row['macroValidationNll']):
            return False
        if any(recipe.get(key) != document['selected'].get(key) for key in ['learningRate', 'epoch']):
            return False
    return True


def export_valid(document, name, expected, trained):
    if not provenance_valid(document, name, expected, readouts=True) or document.get('model') != name or document.get('seed') != 17 or document.get('status') != 'complete' or document.get('completeGraph') is not True or document.get('pilotLimit'):
        return False
    evaluations = document.get('evaluations', {})
    if set(evaluations) != {'CPU_ONLY', 'ALL'} or not document.get('artifact', {}).get('files') or not document.get('inputSpecification') or not document.get('outputSpecification'):
        return False
    verification = document.get('artifactVerification', {})
    expected_metadata = {'protocol_sha256': expected['protocolSha256'], 'revision': expected['models'][name]['revision'], 'readout_sha256': expected['checkpoints'][f'{name}-17.safetensors']['sha256'], 'complete_graph': 'true'}
    if verification.get('allArtifactFileHashesMatched') is not True or verification.get('embeddedModelMetadataMatched') != expected_metadata:
        return False
    for units in ['CPU_ONLY', 'ALL']:
        artifact = document.get('decisionComparisonArtifacts', {}).get(units, {})
        filename = f'export-decisions-{name}-17-{units}.jsonl'
        path = expected['root'] / filename
        if artifact.get('file') != filename or artifact.get('rows') != sum(expected['counts'].values()) or not path.exists() or digest(path.read_bytes()) != artifact.get('sha256'):
            return False
        timing = document.get('isolatedRuntimeMeasurements', {}).get(units, {})
        if timing.get('freshProcess') is not True or timing.get('warmRepetitions') != 30 or not all(finite(timing.get(key)) for key in ['loadMs', 'coldFirstPredictionMs', 'warmMedianMs', 'warmP95Ms', 'peakProcessRssBytes']):
            return False
    recipe = next((row for row in trained.get('recipes', []) if row.get('seed') == 17), {})
    for result in evaluations.values():
        if not all(finite(result.get(key)) for key in ['loadMs', 'coldFirstPredictionMs', 'warmMedianMs', 'warmP95Ms']) or result.get('warmRepetitions') != 30 or not result.get('timingInputId'):
            return False
        if not grouped(result.get('metrics'), sum(expected['counts'].values())):
            return False
        for split in SPLITS:
            check = result.get('splits', {}).get(split, {})
            if not grouped(check.get('metrics'), expected['counts'][split]) or check.get('decisionsCompared') != recipe.get('splits', {}).get(split, {}).get('overall', {}).get('supported') or not finite(check.get('argmaxAgreement'), 0, 1) or not finite(check.get('maxProbabilityDelta'), 0, 1):
                return False
        if result.get('decisionsCompared') != sum(row['decisionsCompared'] for row in result['splits'].values()) or not finite(result.get('argmaxAgreement'), 0, 1) or not finite(result.get('maxProbabilityDelta'), 0, 1):
            return False
    return True


def robustness_valid(document, name, expected):
    if not provenance_valid(document, name, expected, readouts=True) or set(document.get('optionOrder', {})) != {str(seed) for seed in SEEDS}:
        return False
    count = expected['counts']['test']
    for order in document['optionOrder'].values():
        if order.get('cases') != count or not isinstance(order.get('compared'), int) or not 0 < order['compared'] <= count or not finite(order.get('argmaxAgreement'), 0, 1) or not finite(order.get('meanTotalVariation'), 0, 1) or not finite(order.get('maxTotalVariation'), 0, 1):
            return False
    checks = document.get('batchIndependence', {}).get('checks', [])
    if len(checks) != 36 or {row.get('seed') for row in checks} != SEEDS or {row.get('kind') for row in checks} != {'choice', 'boolean', 'ordinal'} or any(not finite(row.get('maxProbabilityDelta'), 0, 1) for row in checks):
        return False
    timing = document.get('mlxTiming', {})
    return timing.get('repetitions') == 30 and all(finite(timing.get(key)) for key in ['loadMs', 'firstPredictionMs', 'warmMedianMs', 'warmP95Ms'])


def audit(root=HERE):
    expected = expected_inputs(root)
    models, blockers = {}, []
    read = lambda name: json.loads((root / name).read_text()) if (root / name).exists() else {}
    for name in ['laya', 'smol', 'qwen']:
        trained, exported, robustness, baselines = [read(path) for path in [f'results-{name}.json', f'export-{name}-17.json', f'robustness-{name}.json', f'frozen-baselines-{name}.json']]
        training_complete = training_valid(trained, name, expected)
        export_complete = training_complete and export_valid(exported, name, expected, trained)
        export_passed = export_complete and all(value['argmaxAgreement'] >= .99 and value['maxProbabilityDelta'] <= .02 for value in exported['evaluations'].values())
        robustness_complete = robustness_valid(robustness, name, expected)
        baseline_complete = provenance_valid(baselines, name, expected) and all(grouped(baselines.get(condition, {}).get(split), expected['counts'][split]) for condition in ['frozenReadout', 'meanInputEmbedding'] for split in SPLITS)
        checks = {'trainingComplete': training_complete, 'coremlCompleteComparison': export_complete, 'coremlAgreementPassed': export_passed, 'robustnessComplete': robustness_complete, 'frozenBaselinesComplete': baseline_complete}
        blockers.extend(f'{name}: {key} evidence is missing, invalid or failed' for key, passed in checks.items() if not passed)
        models[name] = {'trainedSeeds': sorted(row.get('seed', 0) for row in trained.get('recipes', [])), 'coremlStatus': exported.get('status', 'missing'), **checks}
    research_complete = all(all(value[key] for key in ['trainingComplete', 'coremlCompleteComparison', 'robustnessComplete', 'frozenBaselinesComplete']) for value in models.values())
    installed_default = None
    selection = read('default-selection.json')
    if research_complete and selection.get('installedDefault'):
        from select_default import derive_selection
        derived = derive_selection(root)
        selection_matches = all(selection.get(key) == value for key, value in derived.items())
        mac = root.parent / 'mac'
        sys.path.insert(0, str(mac))
        from package_sources import source_manifest
        package_path, registry_path = mac / 'default-package-verification.json', mac / 'models.json'
        if package_path.exists() and registry_path.exists():
            package = json.loads(package_path.read_text())
            registry = json.loads(registry_path.read_text())
            if selection_matches and derived['selectedCandidate'] and selection.get('selectedSeed') == 17 and package.get('passed') is True and package.get('installedSourcesMatched') is True and package.get('shippedSourceSha256') == source_manifest(mac) and package.get('selectedModel') == selection.get('installedDefault') == registry.get('default') and digest(package_path.read_bytes()) == selection.get('packageVerificationSha256') and digest(registry_path.read_bytes()) == selection.get('promotedRegistrySha256') == package.get('proposedRegistrySha256'):
                installed_default = selection['installedDefault']
    if not installed_default:
        blockers.append('No validation-selected distributable default has been promoted and evaluated.')
    return {'schemaVersion': '1', 'protocolSha256': expected['protocolSha256'], 'corpusSha256': expected['corpusSha256'], 'models': models,
            'researchEvidenceComplete': research_complete, 'installedDefault': installed_default,
            'defaultSelection': 'Predefined seed17 validation macro NLL and validation export parity; ALL warm median breaks 0.01 NLL ties. Promotion requires a fresh matching package check.',
            'releaseReady': research_complete and bool(installed_default) and not blockers, 'blockers': blockers}


if __name__ == '__main__':
    report = audit(HERE)
    (HERE / 'release-status.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
