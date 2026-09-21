"""Verify a saved package and link its report to preserved inputs, without prediction."""
import argparse
import json
from pathlib import Path
from datetime import datetime, timezone
from coremltools.proto import Model_pb2
from prepare import HERE, DEFAULT_CACHE
from evidence import file_sha, recorded_provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['laya', 'smol', 'qwen'], required=True)
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    path = HERE / f'export-{args.model}-17.json'
    report = json.loads(path.read_text())
    if report.get('status') != 'complete':
        raise ValueError('A complete export report is required')
    package = args.cache / args.model / f'{args.model}-17-{report["precision"]}.mlpackage'
    actual_files = {str(file.relative_to(package)): file_sha(file) for file in package.rglob('*') if file.is_file()}
    if actual_files != report['artifact']['files']:
        raise ValueError('Export package bytes differ from measured artifact')
    model = Model_pb2.Model()
    model.ParseFromString((package / 'Data/com.apple.CoreML/model.mlmodel').read_bytes())
    metadata = dict(model.description.metadata.userDefined)
    provenance = recorded_provenance(args.cache, args.model, after_run=True)
    checks = {'protocol_sha256': provenance['protocolSha256'], 'revision': provenance['revision'], 'readout_sha256': provenance['readoutSha256']['17'], 'complete_graph': 'true'}
    if any(metadata.get(key) != value for key, value in checks.items()):
        raise ValueError('Package embedded provenance differs from current study inputs')
    if 'provenance' not in report:
        report['provenance'] = provenance
    elif any(report['provenance'].get(key) != provenance[key] for key in ['protocolSha256', 'corpusSha256', 'modelFilesSha256', 'readoutSha256', 'predictionSha256']):
        raise ValueError('Export input provenance changed after measurement')
    report['timingBoundary'] = 'Core ML model.predict with prepared token-ID/mask tensors. Tokenization and input compilation are excluded. MLX robustness timings include both, so the timings are not directly interchangeable.'
    report['artifactVerification'] = {'recordedAtUtc': datetime.now(timezone.utc).isoformat(), 'allArtifactFileHashesMatched': True, 'embeddedModelMetadataMatched': checks,
                                      'predictionRetention': 'Per-row Core ML predictions are retained in the ignored cache when evaluations include predictionsSha256. Earlier Laya evaluation retains complete aggregate comparisons only.'}
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'model': args.model, 'allArtifactFileHashesMatched': True, 'embeddedModelMetadataMatched': True}))


if __name__ == '__main__':
    main()
