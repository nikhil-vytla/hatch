"""Test a proposed validation-selected package before promoting its registry."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from package_sources import source_manifest, verify_installed_sources

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent / 'training'
sys.path.insert(0, str(TRAINING))
from audit_release import audit
from select_default import derive_selection


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-source', type=Path, required=True, help='Previously checksum-verified backbone/readout directory')
    parser.add_argument('--workspace', type=Path, default=HERE.parents[1] / '.cache/typed-study-v1')
    args = parser.parse_args()
    selection = json.loads((TRAINING / 'default-selection.json').read_text())
    derived = derive_selection(TRAINING)
    if any(selection.get(key) != value for key, value in derived.items()):
        raise ValueError('Selected candidate does not match fresh validation-only derivation')
    if not audit(TRAINING)['researchEvidenceComplete'] or selection.get('selectedCandidate') != 'laya' or selection.get('selectedSeed') != 17:
        raise ValueError('Complete evidence and a validation-selected distributable Laya seed17 candidate are required')
    for filename, checksum in selection['evidenceSha256'].items():
        if sha(TRAINING / filename) != checksum:
            raise ValueError('Selection evidence changed: ' + filename)
    identifier = 'laya-readout-experimental'
    registry = json.loads((HERE / 'models.json').read_text())
    registry['default'] = identifier
    registry['models'][identifier]['selection'] = 'Predefined seed17, selected by validation macro NLL among eligible complete exports. Experimental readout adapted on three datasets; no test-based model selection.'
    proposed = json.dumps(registry, indent=2) + '\n'
    shipped_sources = source_manifest(HERE)
    args.workspace.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='default-installation-', dir=args.workspace))
    prefix, data = temporary / 'toolkit', temporary / 'models'
    proposed_path = temporary / 'proposed-models.json'
    proposed_path.write_text(proposed)
    started = time.perf_counter()
    installed = subprocess.run(['bash', str(HERE / 'install.sh'), '--prefix', str(prefix), '--python', sys.executable, '--model-registry', str(proposed_path)], capture_output=True, text=True)
    (temporary / 'installation.log').write_text(installed.stdout + installed.stderr)
    installed.check_returncode()
    if sha(prefix / 'lib/models.json') != sha(proposed_path):
        raise ValueError('Installer did not install the proposed default registry')
    verify_installed_sources(prefix, shipped_sources)
    command = [str(prefix / 'bin/jev-local')]
    model_result = subprocess.run(command + ['install-model', '--data', str(data), '--from-directory', str(args.model_source)], capture_output=True, text=True, check=True)
    doctor = subprocess.run(command + ['doctor', '--data', str(data)], capture_output=True, text=True, check=True)
    # Blocking sockets checks the actual CLI path after installation, including
    # its model-default handling and initialization timing.
    offline = "import runpy,socket,sys; deny=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('network forbidden')); socket.socket.connect=deny; socket.create_connection=deny; script=sys.argv.pop(1); sys.path.insert(0,str(__import__('pathlib').Path(script).parent)); runpy.run_path(script,run_name='__main__')"
    completed = subprocess.run([str(prefix / 'venv/bin/python'), '-c', offline, str(prefix / 'lib/jev_local.py'), 'decide', '--data', str(data), str(HERE / 'examples/decision.json')], capture_output=True, text=True, check=True)
    response = json.loads(completed.stdout)
    selected = {decision['questionId']: decision['selected'] for decision in response.get('decisions', [])}
    if source_manifest(HERE) != shipped_sources:
        raise ValueError('Shipped source files changed during package verification')
    task_passed = selected == {'has-apples': True, 'most-common': 'apple'}
    report = {'schemaVersion': '1', 'recordedAtUtc': datetime.now(timezone.utc).isoformat(), 'selectedModel': identifier, 'selectionArtifactSha256': sha(TRAINING / 'default-selection.json'),
              'freshPrefix': str(prefix), 'freshModelDirectory': str(data), 'dependencyInstallationPassed': True, 'proposedRegistryInstalledByInstaller': True, 'modelInstall': json.loads(model_result.stdout), 'doctor': json.loads(doctor.stdout),
              'proposedRegistry': registry, 'proposedRegistrySha256': hashlib.sha256(proposed.encode()).hexdigest(), 'runtimeSourceSha256': sha(HERE / 'jev_local.py'), 'shippedSourceSha256': shipped_sources, 'installedSourcesMatched': True,
              'networkBlockedDuringDecision': True, 'modelArgumentOmitted': True, 'firstUsefulResult': response, 'semanticTaskPassed': task_passed, 'elapsedSeconds': time.perf_counter() - started,
              'scope': 'Fresh toolkit/model directories. Model bytes copied from the previously tested remote-download cache and rehashed. This authored first-action check does not select the model or establish general task quality.',
              'passed': response.get('status') == 'ok' and response.get('execution', {}).get('model') == registry['models'][identifier]['model'] and task_passed}
    (HERE / 'default-package-verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'semanticTaskPassed': task_passed, 'selectedModel': identifier, 'freshPrefix': str(prefix)}))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
