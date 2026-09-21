"""Retain only newly learned readouts, each below the 2 MB artifact limit."""
import hashlib
import json
import shutil
from prepare import HERE, DEFAULT_CACHE

output = HERE / 'checkpoints'
output.mkdir(exist_ok=True)
manifest = {'selection': 'Learning rate, epoch and temperature use validation only. Seeds 17/29/43 are all retained; no test-based checkpoint choice.', 'backbones': 'Frozen backbone weights are excluded; these files contain only newly learned residual readout parameters.', 'files': {}}
for name in ['laya', 'smol', 'qwen']:
    path = HERE / f'results-{name}.json'
    if not path.exists():
        continue
    result = json.loads(path.read_text())
    for recipe in result['recipes']:
        seed = recipe['seed']
        source = DEFAULT_CACHE / name / f'readout-{seed}.safetensors'
        target = output / f'{name}-{seed}.safetensors'
        if source.stat().st_size >= 2_000_000:
            raise ValueError('Readout exceeds the allowed committed binary size')
        shutil.copyfile(source, target)
        manifest['files'][target.name] = {'model': name, 'seed': seed, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size, 'temperature': recipe['calibration']['temperature'], 'learningRate': recipe['learningRate'], 'epoch': recipe['epoch'], 'baseRevision': result['revision']}
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({name: row['bytes'] for name, row in manifest['files'].items()}))
