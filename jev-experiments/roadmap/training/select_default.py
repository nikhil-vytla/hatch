"""Select an export using validation evidence only; never promote a package.

Seed 17 is the predefined export condition. Repeated seeds quantify variation,
but neither their held-out scores nor a best-seed search select this artifact.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from prepare import HERE, digest
from audit_release import expected_inputs, training_valid, export_valid

MODELS = ('laya', 'smol', 'qwen')
SEED = 17


def candidate(name, trained, exported, protocol_hash):
    reasons = []
    recipes = trained.get('recipes', [])
    if {row.get('seed') for row in recipes} != {17, 29, 43}:
        reasons.append('Three-seed training evidence is incomplete.')
    if trained.get('protocolSha256') != protocol_hash:
        reasons.append('Training protocol hash differs.')
    recipe = next((row for row in recipes if row.get('seed') == SEED), {})
    validation = recipe.get('splits', {}).get('validation', {})
    nll = validation.get('macroNll')
    if not isinstance(nll, (int, float)) or not math.isfinite(nll):
        reasons.append('Validation NLL is missing or nonfinite.')
    if validation.get('overall', {}).get('coverage', 0) < .95:
        reasons.append('Validation coverage is below 95%.')
    if exported.get('status') != 'complete' or exported.get('pilotLimit') or exported.get('completeGraph') is not True or exported.get('seed') != SEED:
        reasons.append('Predefined complete seed17 export comparison is missing.')
    conditions = exported.get('evaluations', {})
    if set(conditions) != {'CPU_ONLY', 'ALL'}:
        reasons.append('Both Core ML compute conditions are required.')
    for units, result in conditions.items():
        parity = result.get('splits', {}).get('validation', {})
        delta = parity.get('maxProbabilityDelta')
        agreement = parity.get('argmaxAgreement')
        if not isinstance(delta, (int, float)) or not math.isfinite(delta) or delta > .02:
            reasons.append(f'{units}: validation probability error exceeds 0.02 or is missing.')
        if not isinstance(agreement, (int, float)) or not math.isfinite(agreement) or agreement < .99:
            reasons.append(f'{units}: validation argmax agreement is below 99% or missing.')
        if parity.get('metrics', {}).get('overall', {}).get('coverage', 0) < .95:
            reasons.append(f'{units}: validation export coverage is below 95%.')
        if parity.get('decisionsCompared') != validation.get('overall', {}).get('supported'):
            reasons.append(f'{units}: validation comparison does not cover every supported row.')
    warm = conditions.get('ALL', {}).get('warmMedianMs')
    if not isinstance(warm, (int, float)) or not math.isfinite(warm) or warm < 0:
        reasons.append('ALL warm median latency is missing or invalid.')
    return {'model': name, 'seed': SEED, 'eligible': not reasons, 'reasons': reasons, 'validationMacroNll': nll, 'allWarmMedianMs': warm}


def select(candidates):
    eligible = [row for row in candidates if row['eligible']]
    if not eligible:
        return None
    best_nll = min(row['validationMacroNll'] for row in eligible)
    tied = [row for row in eligible if row['validationMacroNll'] <= best_nll + .01]
    return min(tied, key=lambda row: (row['allWarmMedianMs'], row['validationMacroNll'], row['model']))


def derive_selection(root=HERE):
    protocol_hash = digest((root / 'PROTOCOL.md').read_bytes())
    expected = expected_inputs(root)
    candidates, evidence = [], {}
    for name in MODELS:
        paths = [root / f'results-{name}.json', root / f'export-{name}-{SEED}.json']
        documents = [json.loads(path.read_text()) if path.exists() else {} for path in paths]
        result = candidate(name, *documents, protocol_hash)
        if not training_valid(documents[0], name, expected) or not export_valid(documents[1], name, expected, documents[0]):
            result['reasons'].append('Complete measurement structure and immutable provenance have not passed the evidence audit.')
            result['eligible'] = False
        candidates.append(result)
        evidence.update({path.name: digest(path.read_bytes()) for path in paths if path.exists()})
    selected = select(candidates)
    return {'protocolSha256': protocol_hash, 'candidates': candidates, 'selectedCandidate': selected['model'] if selected else None, 'selectedSeed': SEED if selected else None, 'evidenceSha256': evidence}


def main():
    report = {'schemaVersion': '1', 'recordedAtUtc': datetime.now(timezone.utc).isoformat(), **derive_selection(HERE),
              'selectionUses': 'Predefined seed17 validation macro NLL; ALL warm median latency within 0.01 NLL of the best eligible model. Both compute conditions must pass validation-only parity.',
              'forbiddenSelectionInputs': ['test metrics', 'transfer metrics', 'global export passed flag', 'best repeated seed'],
              'installedDefault': None, 'packagePromotion': 'Separate verified package promotion is required; this command does not change the model registry.'}
    (HERE / 'default-selection.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'selectedCandidate': report['selectedCandidate'], 'installedDefault': None}))


if __name__ == '__main__':
    main()
