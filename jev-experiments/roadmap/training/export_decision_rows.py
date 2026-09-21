"""Publish comparisons without source passages, prompts or gold distributions."""
import argparse
import json
import math
from pathlib import Path
from prepare import HERE, DEFAULT_CACHE, canonical
from evidence import file_sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['laya', 'smol', 'qwen'], required=True)
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    report_path = HERE / f'export-{args.model}-17.json'
    report = json.loads(report_path.read_text())
    if report.get('status') != 'complete':
        raise ValueError('Complete comparison evidence is required')
    location = args.cache / args.model
    expected = []
    for split in ['validation', 'test', 'transfer']:
        path = location / f'predictions-17-{split}.jsonl'
        if file_sha(path) != report['provenance']['predictionSha256'][path.name]:
            raise ValueError('Original MLX prediction bytes changed')
        expected.extend((split, json.loads(line)) for line in path.read_text().splitlines())
    artifacts = {}
    for units in ['CPU_ONLY', 'ALL']:
        path = location / f'coreml-17-{report["precision"]}-{units}.jsonl'
        if file_sha(path) != report['evaluations'][units]['predictionsSha256']:
            raise ValueError('Core ML prediction bytes changed')
        actual = [json.loads(line) for line in path.read_text().splitlines()]
        if len(actual) != len(expected):
            raise ValueError('Comparison does not include every decision')
        compact, deltas, agreements = [], [], []
        for (split, mlx), coreml in zip(expected, actual):
            if any(mlx[key] != coreml[key] for key in ['id', 'values', 'target', 'status']):
                raise ValueError('MLX and Core ML decision identities differ')
            row = {'id': mlx['id'], 'split': split, 'values': mlx['values'], 'status': mlx['status']}
            if mlx['status'] == 'ok':
                left, right = mlx['probabilities'], coreml['probabilities']
                if len(left) != len(right) or len(right) != len(mlx['values']) or not all(math.isfinite(p) for p in left + right):
                    raise ValueError('Malformed comparison probabilities')
                delta = max(abs(x - y) for x, y in zip(left, right))
                agreement = max(range(len(left)), key=left.__getitem__) == max(range(len(right)), key=right.__getitem__)
                row.update(mlxProbabilities=left, coremlProbabilities=right, maxProbabilityDelta=delta, argmaxAgreement=agreement)
                deltas.append(delta)
                agreements.append(agreement)
            else:
                row['reason'] = mlx.get('reason', 'unsupported')
            compact.append(row)
        evaluation = report['evaluations'][units]
        if len(deltas) != evaluation['decisionsCompared'] or abs(max(deltas) - evaluation['maxProbabilityDelta']) > 1e-12 or abs(sum(agreements) / len(agreements) - evaluation['argmaxAgreement']) > 1e-12:
            raise ValueError('Published comparison rows disagree with aggregate evidence')
        output = HERE / f'export-decisions-{args.model}-17-{units}.jsonl'
        output.write_text(''.join(canonical(row) + '\n' for row in compact))
        artifacts[units] = {'file': output.name, 'sha256': file_sha(output), 'rows': len(compact), 'supported': len(deltas), 'omittedFields': ['state', 'question', 'prompt', 'target'], 'semanticOptionIdsRetained': True}
    report['decisionComparisonArtifacts'] = artifacts
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(artifacts))


if __name__ == '__main__':
    main()
