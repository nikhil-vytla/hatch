"""Run the exact requested independent model on a source-only review snapshot."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROADMAP=HERE.parent
ROOT=ROADMAP.parents[1]
MODEL='amazon-bedrock/global.anthropic.claude-fable-5-1'
p=argparse.ArgumentParser();p.add_argument('gate',choices=['protocol','prototype','release']);a=p.parse_args()
snapshot=Path(tempfile.mkdtemp(prefix='jev-release-review-'))
paths=['jev-experiments/roadmap','jev-experiments/experience-prototypes/src','jev-experiments/experience-prototypes/server/gateway.ts','jev-experiments/adapters/typescript/index.ts']
inventory=[]
for relative in paths:
 source=ROOT/relative
 for path in ([source] if source.is_file() else source.rglob('*')):
  if not path.is_file() or '.local.' in path.name or any(x.startswith('.') or x in ['node_modules','__pycache__','dist'] for x in path.relative_to(source.parent).parts) or path.suffix not in ['.md','.py','.ts','.tsx','.json','.jsonl','.css','.png','.webp','.html','.txt','.diff','.patch','.sh','.yml','.toml']: continue
  # Complete decision comparisons can exceed the image budget. Keep all text
  # evidence available to the reviewer rather than silently dropping rows.
  if path.suffix in ['.png','.webp'] and path.stat().st_size>=2000000: continue
  data=path.read_bytes();dest=snapshot/path.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
  inventory.append({'path':str(path.relative_to(ROOT)),'sha256':hashlib.sha256(data).hexdigest()})
prompt=(HERE/(a.gate+'-prompt.md')).read_text()
permissions={'*':'deny','read':{'*':'allow','*.env':'deny','*.env.*':'deny'},'glob':'allow','grep':'allow','external_directory':'deny'}
config={'$schema':'https://opencode.ai/config.json','model':MODEL,'share':'disabled','snapshot':False,'autoupdate':False,'permission':permissions,'agent':{'release-review':{'description':'Independent read-only release review','mode':'primary','model':MODEL,'steps':35,'permission':permissions}}}
env=os.environ.copy();env.update(OPENCODE_CONFIG_CONTENT=json.dumps(config),OPENCODE_DISABLE_AUTOUPDATE='true',OPENCODE_DISABLE_LSP_DOWNLOAD='true')
start=time.time();events=snapshot/'events.jsonl'
with events.open('w') as out,(snapshot/'stderr.log').open('w') as err:
 result=subprocess.run(['opencode','run','--pure','--dir',str(snapshot),'--agent','release-review','--model',MODEL,'--format','json','--title','Jev '+a.gate+' review',prompt],env=env,stdout=out,stderr=err,timeout=900)
rows=[]
for line in events.read_text().splitlines():
 try:rows.append(json.loads(line))
 except ValueError:pass
texts=[r.get('part',{}).get('text','') for r in rows if r.get('type')=='text']
sessions=list({r['sessionID'] for r in rows if r.get('sessionID')})
(HERE/(a.gate+'-feedback.md')).write_text('\n\n'.join(texts)+'\n')
models=[];cost=0
if sessions:
 for attempt in range(4):
  time.sleep(2)
  # OpenCode's piped stdout can truncate large exports. A file keeps the full
  # JSON available and avoids treating a parse failure as absent model identity.
  export_path=snapshot/'session-export.json'
  with export_path.open('w') as out:
   exported=subprocess.run(['opencode','export',sessions[0]],stdout=out,stderr=subprocess.PIPE,text=True)
  try:
   data=json.loads(export_path.read_text())
   for message in data.get('messages',[]):
    info=message.get('info',{})
    if info.get('role')=='assistant':models.append({'provider':info.get('providerID'),'model':info.get('modelID')});cost+=info.get('cost',0)
  except ValueError: pass
  if models: break
meta={'gate':a.gate,'requested_model':MODEL,'observed_models':[dict(t) for t in {tuple(d.items()) for d in models}],'session_ids':sessions,'exit_code':result.returncode,'elapsed_seconds':time.time()-start,'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'files':inventory,'answer_sha256':hashlib.sha256(('\n\n'.join(texts)+'\n').encode()).hexdigest(),'opencode_reported_cost_usd':cost,'billing_verified':False,'raw_output_local':str(snapshot)}
(HERE/(a.gate+'-provenance.json')).write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps({k:v for k,v in meta.items() if k!='files'}))
if result.returncode or not texts or not models: raise SystemExit('Review did not produce verified model feedback')
if any(m!={'provider':'amazon-bedrock','model':'global.anthropic.claude-fable-5-1'} for m in models):raise SystemExit('Unexpected reviewer model')
