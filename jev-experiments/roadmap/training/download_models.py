"""Prepare revision-pinned study model caches and verify every locked file."""
import argparse
import json
from pathlib import Path
from prepare import HERE, LAB
from study import MODELS, file_digest, verify_weights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['all', *MODELS], default='all')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    manifests = json.loads((HERE / 'models-manifest.json').read_text())
    names = list(MODELS) if args.model == 'all' else [args.model]
    for name in names:
        model, locked = MODELS[name], manifests[name]
        if locked['revision'] != model['revision'] or locked['model'] != model['repo']:
            raise ValueError('Model lock differs from the study configuration')
        if not model['path'].resolve().is_relative_to((LAB / '.cache').resolve()):
            raise ValueError('Model preparation must stay inside the repository cache')
        for filename, expected in locked['files'].items():
            if Path(filename).is_absolute() or '..' in Path(filename).parts:
                raise ValueError('Model file must stay within its cache directory')
            path = model['path'] / filename
            if not path.resolve().is_relative_to(model['path'].resolve()):
                raise ValueError('Model path follows a symlink outside its cache directory')
            if path.exists():
                if path.stat().st_size != expected['bytes'] or file_digest(path) != expected['sha256']:
                    raise ValueError('Existing model file differs from the lock; move it aside explicitly: ' + str(path))
                continue
            if args.verify_only or path.is_symlink():
                raise ValueError('Missing model file: ' + str(path))
            from huggingface_hub import hf_hub_download
            hf_hub_download(model['repo'], filename, revision=model['revision'], local_dir=model['path'])
            if path.stat().st_size != expected['bytes'] or file_digest(path) != expected['sha256']:
                raise ValueError('Downloaded model checksum differs: ' + filename)
        verify_weights(name)
        print(json.dumps({'model': name, 'revision': model['revision'], 'filesVerified': len(locked['files']), 'networkAllowed': not args.verify_only}), flush=True)


if __name__ == '__main__':
    main()
