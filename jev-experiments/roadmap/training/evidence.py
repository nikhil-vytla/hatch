"""Link measurement artifacts to immutable study inputs without loading models."""
import hashlib
import json
from datetime import datetime, timezone
from prepare import HERE, digest


def file_sha(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def input_provenance(cache, name, readouts=True):
    location = cache / name
    model_manifest = json.loads((HERE / 'models-manifest.json').read_text())
    expected = {'model': name, 'revision': model_manifest[name]['revision'], 'corpusSha256': file_sha(HERE / 'corpus-manifest.json'), 'modelFilesSha256': file_sha(HERE / 'models-manifest.json')}
    feature_manifest = json.loads((location / 'feature-manifest.json').read_text())
    if feature_manifest.get('status') != 'complete' or any(feature_manifest.get(key) != value for key, value in expected.items()):
        raise ValueError('Feature provenance does not match the completed study inputs')
    for split in ['train', 'validation', 'test', 'transfer']:
        recorded = feature_manifest.get('splits', {}).get(split, {})
        for suffix, key in [('npz', 'arraysSha256'), ('json', 'metadataSha256')]:
            if file_sha(location / f'{split}.{suffix}') != recorded.get(key):
                raise ValueError('Feature cache bytes changed: ' + split + '.' + suffix)
    result = {**expected, 'protocolSha256': file_sha(HERE / 'PROTOCOL.md'), 'featureManifestSha256': file_sha(location / 'feature-manifest.json')}
    if readouts:
        retained = json.loads((HERE / 'checkpoints/manifest.json').read_text())['files']
        result['readoutSha256'], result['predictionSha256'] = {}, {}
        for seed in [17, 29, 43]:
            checkpoint = f'{name}-{seed}.safetensors'
            checksum = file_sha(location / f'readout-{seed}.safetensors')
            if checksum != retained[checkpoint]['sha256'] or checksum != file_sha(HERE / 'checkpoints' / checkpoint):
                raise ValueError('Cached and retained readouts differ')
            result['readoutSha256'][str(seed)] = checksum
            for split in ['validation', 'test', 'transfer']:
                path = location / f'predictions-{seed}-{split}.jsonl'
                result['predictionSha256'][path.name] = file_sha(path)
    return result


def recorded_provenance(cache, name, readouts=True, after_run=False):
    return {'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
            'recordedAfterRun': after_run,
            'method': 'Retrospective verification of preserved inputs. This links current evidence to unchanged caches; it is not an original execution timestamp.' if after_run else 'Input hashes verified before this measurement run.',
            **input_provenance(cache, name, readouts)}
