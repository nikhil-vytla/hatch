"""Independent local probes. Only tiny temporary fixtures; never load a model."""
import contextlib
import hashlib
import importlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROADMAP = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROADMAP / 'mac'))
sys.path.insert(0, str(ROADMAP / 'training'))
import jev_local as local
import study

results = {}
with tempfile.TemporaryDirectory(prefix='jev-independent-review-') as directory:
    root = Path(directory)
    source = root / 'source'
    source.mkdir()
    (source / 'weights.bin').write_bytes(b'new')
    destination = root / 'data/fixture'
    destination.mkdir(parents=True)
    sentinel = root / 'unrelated-file'
    sentinel.write_bytes(b'preserve me')
    (destination / 'weights.bin.partial').symlink_to(sentinel)
    fixture = {'experimental': True, 'files': [{'path': 'weights.bin', 'bytes': 3, 'sha256': hashlib.sha256(b'new').hexdigest()}]}
    error = None
    with patch.object(local, 'model_spec', return_value=fixture):
        try:
            local.install_model('fixture', root / 'data', source)
        except Exception as e:
            error = str(e)
    results['modelInstallSymlink'] = {'unrelatedFilePreserved': sentinel.read_bytes() == b'preserve me', 'targetIsSymlink': (destination / 'weights.bin').is_symlink(), 'error': error}

    request = {'schemaVersion':'1','requestId':'fixture-request','state':'A fixture','questions':[{'id':'q','kind':'boolean','prompt':'Is this a fixture?'}]}
    request_path=root/'request.json'
    request_path.write_text(json.dumps(request))
    process=subprocess.run([sys.executable,str(ROADMAP/'mac/jev_local.py'),'decide','--model','laya-base-experimental','--data',str(root/'missing'),str(request_path)],text=True,capture_output=True)
    response=json.loads(process.stdout)
    results['missingModelResponse']={'exitCode':process.returncode,'response':response,'missingContractFields':sorted(set(['schemaVersion','requestId','decisions','execution','timing','issues','status'])-response.keys())}

    tiny={'kind':'ordinal','min':1e-11,'max':2e-11,'step':1e-11}
    try:
        values=[value for value,_ in local.options(tiny)]
        results['ordinalIdentity']={'requested':[1e-11,2e-11],'values':values,'preserved':values==[1e-11,2e-11]}
    except Exception as e:
        results['ordinalIdentity']={'rejected':True,'error':str(e)}

    cache=root/'study-cache'
    model=cache/'laya'
    model.mkdir(parents=True)
    for split in ['train','validation','test','transfer']:
        (model/(split+'.npz')).write_bytes(b'old feature fixture; not a real tensor')
    manifest=model/'feature-manifest.json'
    manifest.write_text(json.dumps({'corpusSha256':'stale-corpus','revision':'stale-revision'}))
    modules={name:ModuleType(name) for name in ['numpy','mlx','mlx.core']}
    modules['mlx'].core=modules['mlx.core']
    error=None
    with patch.dict(sys.modules,modules),patch.object(study,'Backbone',return_value=SimpleNamespace(dimension=4)),contextlib.redirect_stdout(io.StringIO()):
        try:
            study.extract(cache,'laya')
        except Exception as e:
            error=str(e)
    after=json.loads(manifest.read_text())
    results['staleFeatureCache']={'oldFeatureBytesUnchanged':(model/'train.npz').read_bytes()==b'old feature fixture; not a real tensor','manifestCorpusAfter':after.get('corpusSha256'),'staleCacheRejected':error is not None,'error':error}

print(json.dumps(results,indent=2))
