"""Export complete frozen backbone + selected MLX readout, then compare decisions.

This original PyTorch conversion bridge uses the checked-in MLX equations and
pinned weight tensors. It never trains in PyTorch or exports a readout alone.
Large weight/package files remain in the ignored cache.
"""
import argparse
import gc
import json
import math
from pathlib import Path
import resource
import statistics
import time
import hashlib
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
import mlx.core as mx
from study import Backbone, MODELS, KINDS, read_rows, metrics, grouped_metrics
from prepare import HERE, DEFAULT_CACHE, digest
from evidence import recorded_provenance

MAX_TOKENS = 768


def install_scalar_conversion_fix():
    """Preserve scalar semantics with NumPy 2.5 and coremltools 9.

    This compatibility handler is also used by the earlier repository export.
    It does not change model math or precision.
    """
    from coremltools.converters.mil.mil import Builder as mb
    from coremltools.converters.mil.frontend.torch.torch_op_registry import register_torch_op
    from coremltools.converters.mil.frontend.torch.ops import _get_inputs

    @register_torch_op(torch_alias=['int'], override=True)
    def scalar_int(context, node):
        x = _get_inputs(context, node, expected=1)[0]
        if x.val is not None:
            if np.size(x.val) != 1:
                raise ValueError('Integer conversion requires exactly one scalar element')
            value = mb.const(val=int(np.asarray(x.val).item()), name=node.name)
        else:
            value = mb.cast(x=mb.squeeze(x=x) if len(x.shape) else x, dtype='int32', name=node.name)
        context.add(value, node.name)


def file_sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''): h.update(part)
    return h.hexdigest()


def tensors(path, quantization=None):
    raw = {}
    for file in sorted(path.glob('*.safetensors')):
        raw.update(mx.load(str(file)))
    dense = {}
    for key, value in raw.items():
        if key.endswith(('.scales', '.biases')):
            continue
        prefix = key.removesuffix('.weight')
        if key.endswith('.weight') and prefix + '.scales' in raw:
            # The study casts floating MLX parameters, including quantization
            # scales/biases, to float32 before inference. Match that arithmetic
            # before dequantizing, rather than rounding dense weights to BF16.
            scales = raw[prefix + '.scales'].astype(mx.float32)
            biases = raw.get(prefix + '.biases')
            value = mx.dequantize(value, scales, biases.astype(mx.float32) if biases is not None else None, group_size=quantization['group_size'], bits=quantization['bits'])
        dense[key] = torch.from_numpy(np.array(value.astype(mx.float32)))
    return dense


class CompleteDecision(nn.Module):
    def __init__(self, name, readout, temperature, labels=None):
        super().__init__()
        self.name, self.temperature = name, temperature
        path = MODELS[name]['path']
        self.cfg = json.loads((path / ('encoder/config.json' if name == 'laya' else 'config.json')).read_text())
        weights = tensors(path, self.cfg.get('quantization'))
        self.names = {}
        for key, value in weights.items():
            if key.startswith('act_head.') or key == 'temperature': continue
            safe = key.replace('.', '__')
            self.register_buffer(safe, value)
            self.names[key] = safe
        self.register_buffer('residual_weight', torch.from_numpy(np.array(readout['weight'])))
        self.register_buffer('residual_bias', torch.from_numpy(np.array(readout['bias'])))
        if labels is not None:
            self.register_buffer('label_ids', torch.tensor(labels, dtype=torch.int64))
        self.register_buffer('positions', torch.arange(MAX_TOKENS))
        self.register_buffer('type_remap', torch.tensor([0, 2, 1], dtype=torch.int64))
        rotary_width = self.cfg.get('head_dim', self.cfg['hidden_size'] // self.cfg['num_attention_heads'])
        thetas = [value['rope_theta'] for value in self.cfg['rope_parameters'].values()] if name == 'laya' else [self.cfg['rope_theta']]
        self.rotary_names = {}
        for index, theta in enumerate(sorted(set(thetas))):
            # Compute large theta constants before tracing. Casting a theta such
            # as 160000 directly to FP16 would overflow before exponentiation.
            frequency = torch.arange(MAX_TOKENS, dtype=torch.float32)[:, None] / (float(theta) ** (torch.arange(0, rotary_width, 2, dtype=torch.float32) / rotary_width))[None, :]
            angles = torch.cat((frequency, frequency), dim=-1)[None, None]
            prefix = 'fixed_rope_' + str(index)
            self.register_buffer(prefix + '_cos', torch.cos(angles))
            self.register_buffer(prefix + '_sin', torch.sin(angles))
            self.rotary_names[theta] = prefix

    def w(self, name):
        return getattr(self, self.names[name])

    def linear(self, x, prefix):
        return F.linear(x, self.w(prefix + '.weight'), self.w(prefix + '.bias') if prefix + '.bias' in self.names else None)

    def norm(self, x, prefix, eps=1e-5):
        return F.layer_norm(x, (x.shape[-1],), self.w(prefix + '.weight'), self.w(prefix + '.bias') if prefix + '.bias' in self.names else None, eps)

    def rms(self, x, prefix):
        return x * torch.rsqrt(x.square().mean(dim=-1, keepdim=True) + self.cfg['rms_norm_eps']) * self.w(prefix + '.weight')

    def rotary(self, x, theta):
        width = x.shape[-1]
        half = width // 2
        rotate = torch.cat((-x[..., half:], x[..., :half]), dim=-1)
        prefix = self.rotary_names[theta]
        return x * getattr(self, prefix + '_cos') + rotate * getattr(self, prefix + '_sin')

    def attention(self, q, k, v, mask):
        return F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=0.0)

    def laya(self, ids, pad, markers, kind):
        c = self.cfg
        h = self.norm(F.embedding(ids.long(), self.w('encoder.embeddings.tok_embeddings.weight')), 'encoder.embeddings.norm')
        heads = c['num_attention_heads']
        n, width = MAX_TOKENS, c['hidden_size']
        # Finite FP16 masks keep fully masked padded query rows finite. Their
        # outputs are never used as valid keys, but NaNs can otherwise propagate.
        base = torch.where(pad[:, None, None, :] > 0, 0., -1e4)
        local = base + torch.where(torch.abs(self.positions[:, None] - self.positions[None, :])[None, None] <= c['local_attention'] // 2, 0., -1e4)
        for i in range(c['num_hidden_layers']):
            p = f'encoder.layers.{i}'
            x = self.norm(h, p + '.attn_norm') if i else h
            q, k, v = self.linear(x, p + '.attn.Wqkv').reshape(1, n, 3, heads, width // heads).permute(2, 0, 3, 1, 4).unbind(0)
            full = i % c['global_attn_every_n_layers'] == 0
            theta = c['rope_parameters']['full_attention' if full else 'sliding_attention']['rope_theta']
            x = self.attention(self.rotary(q, theta), self.rotary(k, theta), v, base if full else local).transpose(1, 2).reshape(1, n, width)
            h = h + self.linear(x, p + '.attn.Wo')
            a, g = self.linear(self.norm(h, p + '.mlp_norm'), p + '.mlp.Wi').chunk(2, dim=-1)
            h = h + self.linear(F.gelu(a) * g, p + '.mlp.Wo')
        h = self.norm(h, 'encoder.final_norm')
        h = h + F.embedding(self.type_remap[kind.long()], self.w('type_emb.weight'))[:, None, :]
        heads = width // 64
        for i in range(2):
            p = f'head.layers.{i}'
            x = self.norm(h, p + '.norm1')
            q, k, v = F.linear(x, self.w(p + '.self_attn.in_proj_weight'), self.w(p + '.self_attn.in_proj_bias')).reshape(1, n, 3, heads, 64).permute(2, 0, 3, 1, 4).unbind(0)
            x = self.attention(q, k, v, base).transpose(1, 2).reshape(1, n, width)
            h = h + self.linear(x, p + '.self_attn.out_proj')
            h = h + self.linear(F.relu(self.linear(self.norm(h, p + '.norm2'), p + '.linear1')), p + '.linear2')
        anchors = torch.gather(h, 1, markers.long()[:, :, None].expand(-1, -1, width))
        features = F.gelu(self.linear(self.norm(anchors, 'scorer.0'), 'scorer.1'))
        logits = self.linear(features, 'scorer.3').squeeze(-1)
        return features, logits

    def causal(self, ids, pad, last_index):
        c = self.cfg
        h = F.embedding(ids.long(), self.w('model.embed_tokens.weight'))
        n, width = MAX_TOKENS, c['hidden_size']
        heads, kv = c['num_attention_heads'], c['num_key_value_heads']
        hd = c.get('head_dim', width // heads)
        mask = torch.where((self.positions[None, :] <= self.positions[:, None])[None, None] & (pad[:, None, None, :] > 0), 0., -1e4)
        for i in range(c['num_hidden_layers']):
            p = f'model.layers.{i}'
            x = self.rms(h, p + '.input_layernorm')
            q = self.linear(x, p + '.self_attn.q_proj').reshape(1, n, heads, hd)
            k = self.linear(x, p + '.self_attn.k_proj').reshape(1, n, kv, hd)
            v = self.linear(x, p + '.self_attn.v_proj').reshape(1, n, kv, hd).transpose(1, 2)
            if self.name == 'qwen':
                q = self.rms(q, p + '.self_attn.q_norm')
                k = self.rms(k, p + '.self_attn.k_norm')
            q, k = self.rotary(q.transpose(1, 2), c['rope_theta']), self.rotary(k.transpose(1, 2), c['rope_theta'])
            k, v = k.repeat_interleave(heads // kv, dim=1), v.repeat_interleave(heads // kv, dim=1)
            x = self.attention(q, k, v, mask).transpose(1, 2).reshape(1, n, heads * hd)
            h = h + self.linear(x, p + '.self_attn.o_proj')
            x = self.rms(h, p + '.post_attention_layernorm')
            h = h + self.linear(F.silu(self.linear(x, p + '.mlp.gate_proj')) * self.linear(x, p + '.mlp.up_proj'), p + '.mlp.down_proj')
        h = self.rms(h, 'model.norm')
        final = torch.gather(h, 1, last_index.long()[:, None, None].expand(-1, 1, width)).squeeze(1)
        embeddings = self.w('model.embed_tokens.weight') if c['tie_word_embeddings'] else self.w('lm_head.weight')
        logits = F.linear(final, embeddings[self.label_ids])
        return final[:, None, :].expand(-1, 8, -1), logits

    def forward(self, input_ids, attention_mask, marker_pos, option_mask, kind, last_index):
        feature, logits = self.laya(input_ids, attention_mask, marker_pos, kind) if self.name == 'laya' else self.causal(input_ids, attention_mask, last_index)
        residual = (feature * self.residual_weight[kind.long()]).sum(dim=-1) + self.residual_bias[kind.long()]
        logits = torch.where(option_mask > 0, logits + residual, -1e4)
        return torch.softmax(logits / self.temperature, dim=-1)


def inputs(backbone, row):
    compiled = backbone.compile(row)
    ids = np.zeros((1, MAX_TOKENS), np.int32)
    if backbone.name == 'laya': ids.fill(compiled['pad'])
    length = len(compiled['ids'])
    ids[0, :length] = compiled['ids']
    pad = np.zeros_like(ids)
    pad[0, :length] = 1
    markers, valid = np.zeros((1, 8), np.int32), np.zeros((1, 8), np.int32)
    if 'markers' in compiled: markers[0, :len(compiled['markers'])] = compiled['markers']
    valid[0, :len(row['values'])] = 1
    return {'input_ids': ids, 'attention_mask': pad, 'marker_pos': markers, 'option_mask': valid, 'kind': np.array([KINDS[row['question']['kind']]], np.int32), 'last_index': np.array([length - 1], np.int32)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', required=True, choices=list(MODELS))
    p.add_argument('--seed', type=int, default=17, choices=[17, 29, 43])
    p.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    p.add_argument('--limit', type=int, default=0, help='Nonzero is explicitly a pilot, never the complete export gate')
    p.add_argument('--precision', choices=['float16', 'float32'], default='float16')
    p.add_argument('--reuse-package', action='store_true', help='Recompare the identical previously hashed package; never skip decision comparisons')
    a = p.parse_args()
    import coremltools as ct
    install_scalar_conversion_fix()
    torch.set_num_threads(4)
    report_path = HERE / f'export-{a.model}-{a.seed}.json'
    report = {'model': a.model, 'seed': a.seed, 'completeGraph': True, 'precision': a.precision, 'pilotLimit': a.limit, 'status': 'started', 'defaultSelected': False,
              'timingBoundary': 'Core ML model.predict with prepared token-ID/mask tensors. Tokenization and input compilation are excluded. MLX robustness timings include both, so the timings are not directly interchangeable.'}
    started = time.perf_counter()
    try:
        study = json.loads((HERE / f'results-{a.model}.json').read_text())
        report['provenance'] = recorded_provenance(a.cache, a.model)
        recipe = next(r for r in study['recipes'] if r['seed'] == a.seed)
        location = a.cache / a.model
        readout = mx.load(str(location / f'readout-{a.seed}.safetensors'))
        backbone = Backbone(a.model)
        complete = CompleteDecision(a.model, readout, recipe['calibration']['temperature'], getattr(backbone, 'labels', None)).eval()
        report['parameterElements'] = {'backbone': sum(complete.w(key).numel() for key in complete.names), 'readout': complete.residual_weight.numel() + complete.residual_bias.numel()}
        report['exportNumerics'] = 'Finite attention masks and rotary tables precomputed in float32 before tracing. Qwen 4-bit weights are dequantized with float32 scales/biases, matching the frozen MLX study arithmetic, then exported as dense floating weights.'
        rows = read_rows(a.cache, 'validation')
        supported = [r for r, ok in zip(rows, np.load(location / 'validation.npz')['supported']) if ok]
        parity = []
        parity_rows = [next(row for row in supported if row['question']['kind'] == kind) for kind in ['choice', 'boolean', 'ordinal']]
        report['torchBridgeValidationIds'] = [row['id'] for row in parity_rows]
        validation_predictions = {r['id']: r for r in [json.loads(s) for s in (location / f'predictions-{a.seed}-validation.jsonl').read_text().splitlines()]}
        for row in parity_rows:
            data = inputs(backbone, row)
            with torch.no_grad():
                actual = complete(*[torch.from_numpy(x) for x in data.values()]).numpy()[0, :len(row['values'])]
            if not np.isfinite(actual).all() or abs(actual.sum() - 1) > 1e-4:
                raise ValueError('Complete PyTorch bridge returned invalid probabilities')
            expected = np.array(validation_predictions[row['id']]['probabilities'])
            parity.append(float(np.max(np.abs(actual - expected))))
        report['torchVsMlxValidationProbabilityDelta'] = parity
        if max(parity) > 0.02:
            raise ValueError('Complete PyTorch bridge disagrees with MLX above 0.02')
        with torch.no_grad():
            traced = torch.jit.trace(complete, tuple(torch.from_numpy(x) for x in data.values()), check_trace=False)
        package = location / f'{a.model}-{a.seed}-{a.precision}.mlpackage'
        converted = None
        if a.reuse_package:
            prior = json.loads(report_path.read_text())
            actual_files = {str(file.relative_to(package)): file_sha(file) for file in package.rglob('*') if file.is_file()}
            if prior.get('status') != 'complete' or prior.get('precision') != a.precision or actual_files != prior.get('artifact', {}).get('files'):
                raise ValueError('A complete prior comparison of these exact package bytes is required for reuse')
            report['reusedArtifactFromReportSha256'] = file_sha(report_path)
            archive = HERE / 'export-attempts' / f'{a.model}-{a.seed}-{a.precision}-before-row-retention.json'
            archive.parent.mkdir(exist_ok=True)
            if not archive.exists(): archive.write_bytes(report_path.read_bytes())
        else:
            converted = ct.convert(traced, convert_to='mlprogram', minimum_deployment_target=ct.target.macOS14, compute_precision=ct.precision.FLOAT16 if a.precision == 'float16' else ct.precision.FLOAT32, inputs=[ct.TensorType(name=k, shape=v.shape, dtype=np.int32) for k, v in data.items()], outputs=[ct.TensorType(name='probabilities')])
            converted.user_defined_metadata.update({'protocol_sha256': study['protocolSha256'], 'backbone': MODELS[a.model]['repo'], 'revision': MODELS[a.model]['revision'], 'readout_sha256': file_sha(location / f'readout-{a.seed}.safetensors'), 'temperature': str(recipe['calibration']['temperature']), 'complete_graph': 'true'})
            converted.save(str(package))
        report['inputSpecification'] = {key: {'shape': list(value.shape), 'dtype': 'int32'} for key, value in data.items()}
        report['outputSpecification'] = {'probabilities': {'shape': [1, 8], 'meaning': 'final calibrated masked decision probabilities'}}
        report['artifact'] = {'bytes': sum(x.stat().st_size for x in package.rglob('*') if x.is_file()), 'files': {str(x.relative_to(package)): file_sha(x) for x in package.rglob('*') if x.is_file()}}
        del converted, traced, complete
        gc.collect()
        evaluations = {}
        timing_row = supported[0]
        timing_data = inputs(backbone, timing_row)
        for units in [ct.ComputeUnit.CPU_ONLY, ct.ComputeUnit.ALL]:
            load_start = time.perf_counter()
            model = ct.models.MLModel(str(package), compute_units=units)
            load_ms = (time.perf_counter() - load_start) * 1000
            measurements, diffs, agreements, out_rows = [], [], [], []
            split_checks = {}
            for split in ['validation', 'test', 'transfer']:
                split_diffs, split_agreements, split_rows = [], [], []
                predictions = [json.loads(s) for s in (location / f'predictions-{a.seed}-{split}.jsonl').read_text().splitlines()]
                if a.limit: predictions = predictions[:a.limit]
                for row_index, row in enumerate(predictions):
                    if row['status'] != 'ok':
                        out_rows.append(row)
                        split_rows.append(row)
                        continue
                    data = inputs(backbone, row)
                    start = time.perf_counter()
                    prob = model.predict(data)['probabilities'][0, :len(row['values'])]
                    if not np.isfinite(prob).all() or abs(prob.sum() - 1) > .001:
                        raise ValueError('Core ML returned invalid probabilities')
                    measurements.append((time.perf_counter() - start) * 1000)
                    expected = np.array(row['probabilities'])
                    delta = float(np.max(np.abs(prob - expected)))
                    agreement = bool(np.argmax(prob) == np.argmax(expected))
                    diffs.append(delta)
                    agreements.append(agreement)
                    split_diffs.append(delta)
                    split_agreements.append(agreement)
                    evaluated = {**row, 'probabilities': prob.tolist()}
                    out_rows.append(evaluated)
                    split_rows.append(evaluated)
                    if (row_index + 1) % 128 == 0:
                        print(json.dumps({'model': a.model, 'computeUnits': units.name, 'split': split, 'done': row_index + 1, 'total': len(predictions), 'elapsedSeconds': time.perf_counter() - started}), flush=True)
                split_checks[split] = {'decisionsCompared': len(split_diffs), 'argmaxAgreement': sum(split_agreements) / len(split_agreements), 'maxProbabilityDelta': max(split_diffs), 'metrics': grouped_metrics(split_rows)}
            warm = []
            for _ in range(30):
                start = time.perf_counter()
                model.predict(timing_data)
                warm.append((time.perf_counter() - start) * 1000)
            evaluations[units.name] = {'decisionsCompared': len(diffs), 'argmaxAgreement': sum(agreements) / len(agreements), 'maxProbabilityDelta': max(diffs), 'metrics': grouped_metrics(out_rows), 'splits': split_checks, 'loadMs': load_ms, 'coldFirstPredictionMs': measurements[0], 'warmMedianMs': statistics.median(warm), 'warmP95Ms': sorted(warm)[28], 'warmRepetitions': 30, 'timingInputId': timing_row['id']}
            output_path = location / f'coreml-{a.seed}-{a.precision}-{units.name}.jsonl'
            output_path.write_text(''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in out_rows))
            evaluations[units.name]['predictionsSha256'] = file_sha(output_path)
            del model
            gc.collect()
        validation_gate = not a.limit and all(v['splits']['validation']['argmaxAgreement'] >= .99 and v['splits']['validation']['maxProbabilityDelta'] <= .02 and v['splits']['validation']['metrics']['overall']['coverage'] >= .95 for v in evaluations.values())
        report.update(status='complete' if not a.limit else 'pilot', evaluations=evaluations, validationOnlyDefaultEligibility=validation_gate, defaultEligibilityUses='Validation rows only; held-out and transfer parity cannot select the installed default.', passed=not a.limit and all(v['argmaxAgreement'] >= .99 and v['maxProbabilityDelta'] <= .02 for v in evaluations.values()))
    except Exception as error:
        report.update(status='failed', error={'type': type(error).__name__, 'message': str(error)}, passed=False)
    report.update(elapsedSeconds=time.perf_counter() - started, peakProcessRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, peakMlxBytes=mx.get_peak_memory())
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    if report['status'] == 'failed': raise SystemExit(1)

if __name__ == '__main__': main()
