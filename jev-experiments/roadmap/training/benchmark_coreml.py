"""Measure one complete Core ML package in an isolated process, without MLX."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import statistics
import time
import numpy as np
import coremltools as ct


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--inputs', required=True, type=Path)
    parser.add_argument('--compute', choices=['CPU_ONLY', 'ALL'], required=True)
    args = parser.parse_args()
    inputs = dict(np.load(args.inputs))
    start = time.perf_counter()
    model = ct.models.MLModel(str(args.package), compute_units=getattr(ct.ComputeUnit, args.compute))
    load_ms = (time.perf_counter() - start) * 1000
    start = time.perf_counter()
    first = model.predict(inputs)['probabilities']
    first_ms = (time.perf_counter() - start) * 1000
    if not np.isfinite(first).all() or abs(first.sum() - 1) > .001:
        raise ValueError('Fresh process prediction is invalid')
    warm = []
    for _ in range(30):
        start = time.perf_counter()
        model.predict(inputs)
        warm.append((time.perf_counter() - start) * 1000)
    print(json.dumps({'computeUnits': args.compute, 'freshProcess': True, 'loadMs': load_ms, 'coldFirstPredictionMs': first_ms, 'coldLoadPlusFirstPredictionMs': load_ms + first_ms,
                      'warmMedianMs': statistics.median(warm), 'warmP95Ms': sorted(warm)[28], 'warmRepetitions': 30, 'peakProcessRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                      'inputTensorsSha256': hashlib.sha256(args.inputs.read_bytes()).hexdigest(),
                      'timingBoundary': 'Prepared token-ID/mask tensors, complete Core ML inference. File reading, tokenization and input preparation are outside timing. Fresh Python process per compute condition; OS file and Core ML compilation caches are not flushed.',
                      'memoryBoundary': 'Peak fresh Python/Core ML evaluation process including imported libraries; no MLX model or PyTorch conversion graph is loaded.'}))


if __name__ == '__main__':
    main()
