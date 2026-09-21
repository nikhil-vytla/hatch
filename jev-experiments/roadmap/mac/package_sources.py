"""Integrity boundary for the files shipped or executed by the Mac installer."""
import hashlib

SOURCE_FILES = [
    'jev_local.py', 'install.sh', 'requirements-inference.txt', 'CREDITS.md',
    '../../local-models-and-games/apple/mlx_model.py',
    '../training/checkpoints/laya-17.safetensors', 'examples/decision.json',
]


def source_manifest(root):
    return {filename: hashlib.sha256((root / filename).read_bytes()).hexdigest() for filename in SOURCE_FILES}


def verify_installed_sources(prefix, expected):
    installed = {
        'lib/jev_local.py': 'jev_local.py',
        'lib/mlx_model.py': '../../local-models-and-games/apple/mlx_model.py',
        'lib/requirements-inference.txt': 'requirements-inference.txt',
        'CREDITS.md': 'CREDITS.md',
        'lib/checkpoints/laya-17.safetensors': '../training/checkpoints/laya-17.safetensors',
    }
    for filename, source in installed.items():
        if hashlib.sha256((prefix / filename).read_bytes()).hexdigest() != expected[source]:
            raise ValueError('Installed bytes differ from verified source: ' + filename)
