"""Option-order, batch-independence and MLX timing checks after recipe selection."""
import argparse
import json
import resource
import statistics
import time
from pathlib import Path
import numpy as np
import mlx.core as mx
from study import Backbone, KINDS, UnsupportedInput, read_rows, grouped_metrics
from prepare import HERE, DEFAULT_CACHE
from evidence import recorded_provenance


def run(cache, name):
    provenance = recorded_provenance(cache, name)
    started = time.perf_counter()
    backbone = Backbone(name)
    location = cache / name
    report = json.loads((HERE / f'results-{name}.json').read_text())
    readouts = {r['seed']: mx.load(str(location / f'readout-{r["seed"]}.safetensors')) for r in report['recipes']}
    temperatures = {r['seed']: r['calibration']['temperature'] for r in report['recipes']}
    mx.eval(list(readouts.values()))
    load_ms = (time.perf_counter() - started) * 1000

    def probabilities(feature, logits, kind, count, seed=17):
        weights = readouts[seed]
        w = weights['weight'][kind] if name == 'laya' else weights['weight'][kind, :count]
        bias = weights['bias'][kind] if name == 'laya' else weights['bias'][kind, :count]
        return mx.softmax((logits + mx.sum(feature * w, axis=-1) + bias) / temperatures[seed], axis=-1)

    def decide(row):
        feature, logits, _ = backbone.features(row)
        p = probabilities(feature, logits, KINDS[row['question']['kind']], len(row['values']))
        mx.eval(p)
        return p
    supported = [r for r, m in zip(read_rows(cache, 'validation'), json.loads((location / 'validation.json').read_text())) if m['status'] == 'ok']
    timing_row = supported[0]
    first = time.perf_counter()
    decide(timing_row)
    cold = (time.perf_counter() - first) * 1000
    warm = []
    for _ in range(30):
        start = time.perf_counter()
        decide(timing_row)
        warm.append((time.perf_counter() - start) * 1000)
    rows = read_rows(cache, 'test')
    output = {'model': name, 'provenance': provenance, 'optionOrder': {}, 'batchIndependence': {}, 'limits': {'maxTokens': 768, 'maxOptions': 8, 'maxQuestions': 32}}
    order_features = []
    for row in rows:
        reversed_row = {**row, '_reverseOptions': True, 'values': list(reversed(row['values'])), 'target': list(reversed(row['target']))}
        try:
            feature, logits, item = backbone.features(reversed_row)
            order_features.append((np.array(feature), np.array(logits)))
        except UnsupportedInput:
            order_features.append(None)
    for recipe in report['recipes']:
        seed = recipe['seed']
        weight = mx.load(str(location / f'readout-{seed}.safetensors'))
        original = [json.loads(x) for x in (location / f'predictions-{seed}-test.jsonl').read_text().splitlines()]
        agreements, tvs = [], []
        for row, base, extracted in zip(rows, original, order_features):
            if base['status'] != 'ok' or extracted is None:
                continue
            f, z = extracted
            kind = KINDS[row['question']['kind']]
            count = len(row['values'])
            w = weight['weight'][kind] if name == 'laya' else weight['weight'][kind, :count]
            bias = weight['bias'][kind] if name == 'laya' else weight['bias'][kind, :count]
            pred = np.array(mx.softmax((mx.array(z) + mx.sum(mx.array(f) * w, axis=-1) + bias) / recipe['calibration']['temperature']))[::-1]
            expected = np.array(base['probabilities'])
            agreements.append(bool(pred.argmax() == expected.argmax()))
            tvs.append(float(np.abs(pred - expected).sum() / 2))
        output['optionOrder'][str(seed)] = {'cases': len(rows), 'compared': len(agreements), 'coverage': len(agreements) / len(rows), 'argmaxAgreement': sum(agreements) / len(agreements), 'meanTotalVariation': statistics.mean(tvs), 'maxTotalVariation': max(tvs)}
    # Exactly equal lengths permit a true batch comparison without changing any
    # model-specific padding policy. Distinct neighbor text catches cross-row mixing.
    batch_checks = []
    batch_rows = [row for kind in ['choice', 'boolean', 'ordinal'] for row in [r for r in supported if r['question']['kind'] == kind][:4]]
    for row in batch_rows:
        item = backbone.compile(row)
        if name == 'laya':
            n, count = len(item['ids']), len(item['values'])
            ids = np.array([item['ids'], item['ids']], np.int32)
            ids[1, -2] = ids[0, -3]
            mask = mx.ones((2, n), dtype=mx.int32)
            markers = mx.array([item['markers'], item['markers']])
            valid = mx.ones((2, count), dtype=mx.bool_)
            kinds = mx.array([item['qtype'], item['qtype']])
            batch_feature, batch_logits = backbone.laya_batch_features(mx.array(ids), mask, markers, kinds)
            single_feature, single_logits = backbone.laya_batch_features(mx.array(ids[:1]), mask[:1], markers[:1], kinds[:1])
        else:
            ids = np.array([item['ids'], item['ids']], np.int32)
            ids[1, -2] = ids[0, -3]
            count = len(row['values'])
            batch_h = backbone.model.model(mx.array(ids))[:, -1, :]
            single_h = backbone.model.model(mx.array(ids[:1]))[:, -1, :]
            projection = backbone.model.model.embed_tokens if backbone.model.args.tie_word_embeddings else backbone.model.lm_head
            project = projection.as_linear if backbone.model.args.tie_word_embeddings else projection
            batch_logits = project(batch_h)[:, backbone.labels[:count]]
            single_logits = project(single_h)[:, backbone.labels[:count]]
            batch_feature = mx.broadcast_to(batch_h[:, None, :], (2, count, batch_h.shape[-1]))
            single_feature = mx.broadcast_to(single_h[:, None, :], (1, count, single_h.shape[-1]))
        for seed in [17, 29, 43]:
            kind, count = KINDS[row['question']['kind']], len(row['values'])
            batch = probabilities(batch_feature, batch_logits, kind, count, seed)
            single = probabilities(single_feature, single_logits, kind, count, seed)
            error = float(mx.max(mx.abs(batch[0] - single[0])))
            batch_checks.append({'id': row['id'], 'kind': row['question']['kind'], 'seed': seed, 'maxProbabilityDelta': error})
    output['batchIndependence'] = {'condition': 'Complete adapted probabilities, all three seeds. Batch of two equal-length sequences; second row has a changed content token.', 'checks': batch_checks, 'maxProbabilityDelta': max(x['maxProbabilityDelta'] for x in batch_checks), 'passed': max(x['maxProbabilityDelta'] for x in batch_checks) < .02}
    output['mlxTiming'] = {'loadMs': load_ms, 'firstPredictionMs': cold, 'firstPredictionWasCold': True, 'note': 'Fresh process, complete seed17 decision including tokenization, backbone, residual readout and calibrated softmax. OS file cache is not flushed.', 'warmMedianMs': statistics.median(warm), 'warmP95Ms': sorted(warm)[28], 'repetitions': 30, 'inputId': timing_row['id'], 'peakProcessRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'peakMlxBytes': mx.get_peak_memory()}
    (HERE / f'robustness-{name}.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps({'model': name, 'order': output['optionOrder'], 'batch': output['batchIndependence']['passed']}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, choices=['laya', 'smol', 'qwen'])
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    run(args.cache, args.model)
