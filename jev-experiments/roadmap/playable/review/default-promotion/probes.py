"""CPU-only promotion boundary probes. Production files are never written.

The promotion fixture stubs research readiness and validation selection. It supplies a
matching selection/package pair and mutates a temporary inference helper after
package verification, without loading a model or invoking the installer.
"""
import builtins
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROADMAP = HERE.parents[2]
TRAINING, MAC = ROADMAP / 'training', ROADMAP / 'mac'
sys.path.insert(0, str(TRAINING))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def doctor_probe():
    local = load(MAC / 'jev_local.py', 'review_local')
    original_import = builtins.__import__
    def without_inference(name, *args, **kwargs):
        if name in ['mlx.core', 'numpy', 'tokenizers']:
            return object()
        return original_import(name, *args, **kwargs)
    with tempfile.TemporaryDirectory(prefix='jev-default-doctor-') as temporary:
        root = Path(temporary)
        registry = json.loads((MAC / 'models.json').read_text())
        registry['default'] = 'laya-readout-experimental'
        local.MANIFEST = root / 'models.json'
        local.MANIFEST.write_text(json.dumps(registry))
        results = {}
        variants = [('installerOriginalCommand', [])]
        if '--runtime-only' in (MAC / 'jev_local.py').read_text():
            variants.append(('installerRuntimeOnlyCommand', ['--runtime-only']))
        for label, flags in variants:
            output = io.StringIO()
            with patch.object(sys, 'argv', ['jev-local', 'doctor', '--data', str(root / 'missing-models'), *flags]), patch('builtins.__import__', without_inference), contextlib.redirect_stdout(output):
                code = local.main()
            results[label] = {'exitCode': code, 'response': json.loads(output.getvalue())}
        results['installerUsesRuntimeOnly'] = 'doctor --runtime-only' in (MAC / 'install.sh').read_text()
        return results


def helper_mutation_probe(mutate=True):
    promotion = load(TRAINING / 'promote_default.py', 'review_promote')
    with tempfile.TemporaryDirectory(prefix='jev-promotion-integrity-') as temporary:
        lab = Path(temporary) / 'jev-experiments'
        training, mac = lab / 'roadmap/training', lab / 'roadmap/mac'
        training.mkdir(parents=True)
        mac.mkdir(parents=True)
        helper = lab / 'local-models-and-games/apple/mlx_model.py'
        helper.parent.mkdir(parents=True)
        helper.write_bytes((ROADMAP.parent / 'local-models-and-games/apple/mlx_model.py').read_bytes())
        (mac / 'jev_local.py').write_bytes((MAC / 'jev_local.py').read_bytes())
        shipped = None
        if (MAC / 'package_sources.py').exists():
            source_checker = load(MAC / 'package_sources.py', 'review_package_sources')
            (mac / 'package_sources.py').write_bytes((MAC / 'package_sources.py').read_bytes())
            for filename in source_checker.SOURCE_FILES:
                target = mac / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((MAC / filename).read_bytes())
            shipped = source_checker.source_manifest(mac)
        (mac / 'models.json').write_text(json.dumps({'default': None, 'models': {}}))
        evidence = training / 'fixture-evidence.json'
        evidence.write_text('{"fixture":true}\n')
        selection_path = training / 'default-selection.json'
        selection_path.write_text(json.dumps({'selectedCandidate': 'laya', 'selectedSeed': 17,
                                               'evidenceSha256': {evidence.name: sha(evidence)}}))
        registry = {'default': 'fixture-readout', 'models': {'fixture-readout': {'experimental': True}}}
        proposed = json.dumps(registry, indent=2) + '\n'
        package = {'passed': True, 'selectedModel': 'fixture-readout',
                   'selectionArtifactSha256': sha(selection_path),
                   'runtimeSourceSha256': sha(mac / 'jev_local.py'),
                   'proposedRegistry': registry,
                   'proposedRegistrySha256': hashlib.sha256(proposed.encode()).hexdigest()}
        if shipped is not None:
            package.update(shippedSourceSha256=shipped, installedSourcesMatched=True)
        (mac / 'default-package-verification.json').write_text(json.dumps(package))
        verified_helper = sha(helper)
        if mutate:
            helper.write_text('# Changed after package verification.\n')
        promotion.HERE = training
        promotion.audit = lambda root: {'researchEvidenceComplete': True}
        if hasattr(promotion, 'derive_selection'):
            promotion.derive_selection = lambda root: json.loads(selection_path.read_text())
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                promotion.main()
            status = {'promoted': True, 'output': output.getvalue().strip()}
        except Exception as error:
            status = {'promoted': False, 'errorType': type(error).__name__, 'message': str(error)}
        return {**status, 'verifiedHelperSha256': verified_helper, 'changedHelperSha256': sha(helper),
                'registryDefaultAfter': json.loads((mac / 'models.json').read_text())['default'],
                'scope': 'Research-complete and validation-selection gates stubbed; all writes confined to a synthetic temporary selection/package fixture.'}


if __name__ == '__main__':
    report = {'scope': 'CPU only. Dependency imports stubbed for doctor; no installation, model execution, GPU or production promotion.',
              'sourceHashes': {str(path.relative_to(ROADMAP)): sha(path) for path in
                               [TRAINING / 'promote_default.py', TRAINING / 'select_default.py',
                                TRAINING / 'audit_release.py', MAC / 'verify_default_package.py',
                                MAC / 'jev_local.py', MAC / 'install.sh']},
              'freshDefaultDoctor': doctor_probe(), 'unchangedFixtureControl': helper_mutation_probe(False),
              'changedInferenceHelper': helper_mutation_probe()}
    destination = HERE / (sys.argv[1] if len(sys.argv) > 1 else 'probe-results.json')
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(destination), 'freshDefaultDoctor': report['freshDefaultDoctor'],
                      'changedInferenceHelper': report['changedInferenceHelper']}, indent=2))
