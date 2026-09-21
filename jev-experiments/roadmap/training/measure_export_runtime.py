"""Prepare the fixed validation input, then serialize isolated runtime measurements."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
from prepare import HERE, DEFAULT_CACHE
from study import Backbone, read_rows
from export_coreml import inputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['laya', 'smol', 'qwen'], required=True)
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    path = HERE / f'export-{args.model}-17.json'
    report = json.loads(path.read_text())
    if report['status'] != 'complete':
        raise ValueError('Complete export evidence is required before timing')
    input_id = report['evaluations']['ALL']['timingInputId']
    row = next(row for row in read_rows(args.cache, 'validation') if row['id'] == input_id)
    backbone = Backbone(args.model)
    input_path = args.cache / args.model / 'coreml-timing-input.npz'
    np.savez(input_path, **inputs(backbone, row))
    del backbone
    package = args.cache / args.model / f'{args.model}-17-{report["precision"]}.mlpackage'
    measured = {}
    for units in ['CPU_ONLY', 'ALL']:
        completed = subprocess.run([sys.executable, str(HERE / 'benchmark_coreml.py'), '--package', str(package), '--inputs', str(input_path), '--compute', units], check=True, capture_output=True, text=True)
        value = json.loads(completed.stdout)
        value['timingInputId'] = input_id
        measured[units] = value
        print(json.dumps({'model': args.model, 'computeUnits': units, 'warmMedianMs': value['warmMedianMs']}), flush=True)
    report['isolatedRuntimeMeasurements'] = measured
    report['memoryBoundary'] = 'Top-level peakProcessRssBytes covers the full conversion/evaluation process. Use isolatedRuntimeMeasurements for fresh Core ML process memory.'
    path.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
