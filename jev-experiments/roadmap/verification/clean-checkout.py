"""Verify the delivered research folder plus patch, without prepared assets or caches."""
from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,tarfile,tempfile,time
from datetime import datetime, timezone
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reference-root',type=Path,default=ROOT,help='Working build to compare with the clean branch build')
parser.add_argument('--output',type=Path,default=HERE/'clean-checkout.json')
args=parser.parse_args()
REFERENCE=args.reference_root.resolve()
BASE=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
DEST=Path(tempfile.mkdtemp(prefix='jev-release-clean-'))
with tempfile.TemporaryFile() as archive:
 subprocess.run(['git','archive',BASE],cwd=ROOT,stdout=archive,check=True);archive.seek(0)
 with tarfile.open(fileobj=archive) as t:t.extractall(DEST,filter='data')
def ignore(directory,names):
 return [n for n in names if n in ['node_modules','__pycache__','.venv','.cache','output'] or '.local.' in n]
shutil.copytree(HERE.parent,DEST/'jev-experiments/roadmap',dirs_exist_ok=True,ignore=ignore)
rows=[]
commands=[(['sh','jev-experiments/roadmap/apply.sh'],'.'),(['bun','install','--frozen-lockfile'],'jev-experiments/experience-prototypes'),(['bun','run','build'],'jev-experiments/experience-prototypes'),(['bun','install','--frozen-lockfile'],'jev-experiments/roadmap'),(['bun','install','--frozen-lockfile'],'jev-experiments/adapters/typescript'),(['bun','verification/publication.ts'],'jev-experiments/roadmap'),(['bun','verification/evidence-assets.ts'],'jev-experiments/roadmap'),(['bun','test','runtime','routing','materials','playable'],'jev-experiments/roadmap')]
for command,cwd in commands:
 start=time.time();r=subprocess.run(command,cwd=DEST/cwd,text=True,capture_output=True,timeout=240)
 rows.append({'command':command,'cwd':cwd,'exitCode':r.returncode,'elapsedSeconds':time.time()-start,'output':(r.stdout+r.stderr)[-16000:]});print(('PASS' if r.returncode==0 else 'FAIL')+' '+' '.join(command),flush=True)
 if r.returncode:break
comparison=[]
if len(rows)==len(commands) and all(r['exitCode']==0 for r in rows):
 publication=json.loads((ROOT/'jev-experiments/experience-prototypes/publication.json').read_text())
 for name in sorted(publication):
  relative=Path('jev-experiments/experience-prototypes/public/data')/(name+'.json')
  working=REFERENCE/relative;clean=DEST/relative
  working_hash=hashlib.sha256(working.read_bytes()).hexdigest() if working.is_file() else None
  clean_hash=hashlib.sha256(clean.read_bytes()).hexdigest() if clean.is_file() else None
  comparison.append({'path':str(relative),'workingSha256':working_hash,'cleanSha256':clean_hash,'equal':working_hash is not None and working_hash==clean_hash})
report={'recordedAt':datetime.now(timezone.utc).isoformat(),'baseCommit':BASE,'patchSha256':hashlib.sha256((HERE.parent/'application.patch').read_bytes()).hexdigest(),'preparedAssetsCopied':False,'applicationBuiltBeforeSiblingInstalls':True,'localCheckout':str(DEST),'referenceRoot':str(REFERENCE),'checks':rows,'workingBuildComparison':comparison,'passed':len(rows)==len(commands) and all(r['exitCode']==0 for r in rows) and len(comparison)>0 and all(r['equal'] for r in comparison)}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(report,indent=2)+'\n')
if not report['passed']:raise SystemExit(1)
