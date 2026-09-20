"""Publish the actual inputs behind measurements. Upstream code is never copied."""
import json,csv
from pathlib import Path
lab=Path('..').resolve(); out=Path('public/data')
manifest=json.loads((lab/'.cache/sources.json').read_text())
def source(repo,path):
 return lab/'.cache/upstream'/repo/manifest[repo]['commit']/path
def read(name):return json.loads((out/f'{name}.json').read_text())
def write(name,obj):(out/f'{name}.json').write_text(json.dumps(obj,ensure_ascii=False,separators=(',',':'))+'\n')
pairs={}
for f in manifest['ScalerLab/JudgeBench']['files']:
 for line in source('ScalerLab/JudgeBench',f).read_text().splitlines():
  p=json.loads(line);pairs[p['pair_id']]=p
judge=read('judge')
for r in judge['result']['rows']:
 p=pairs[r.get('pair_id',r['id'].split('/')[0])];swap=r.get('swap',r['id'].endswith('/True'))
 r.update(question=p['question'],candidate_a=p['response_B' if swap else 'response_A'],candidate_b=p['response_A' if swap else 'response_B'],source=p['source'],response_model=p['response_model'],target=('B' if p['label'][0]=='A' else 'A') if swap else p['label'][0],pair_id=p['pair_id'],swap=swap)
judge['result']['description']='For each question, Jev chooses which of two answers is more correct. The dataset provides the expected choice. Each pair appears in both orders to expose position bias.'
judge['result']['source_url']='https://github.com/ScalerLab/JudgeBench/tree/'+manifest['ScalerLab/JudgeBench']['commit']
write('judge',judge)
bank=list(csv.DictReader(source('PolyAI-LDN/task-specific-datasets','banking_data/test.csv').open()))
robust=read('robustness')
requests={}
log=lab/'runs'/robust['manifest']['id']/'requests.jsonl'
if log.exists():
 for line in log.read_text().splitlines():
  req=json.loads(line)
  if req.get('request'):requests[req['tag']]=req['request']
for r in robust['result']['rows']:
 ident=r.get('case',r['id'].rsplit('/',1)[0]);r['original_text']=bank[int(ident.split('/')[-1])]['text']
 state=requests.get(r['id'],{}).get('state',r['original_text'])
 r['text']=state if isinstance(state,str) else json.dumps(state,ensure_ascii=False,indent=2)
 r['variant']=r.get('variant',r['id'].split('/')[-1])
robust['result']['description']='The same banking request is repeated, its answer options reordered, or irrelevant text added. A robust decision should remain stable when meaning stays the same. The injection condition deliberately tries to change the task.'
write('robustness',robust)
clinc=json.loads(source('clinc/oos-eval','data/data_full.json').read_text())
classification=read('classify')
for name,e in classification['result']['experiments'].items():
 for r in e['rows']:
  if 'text' not in r:
   parts=r['id'].split('/');idx=int(parts[-1])
   r['text']=bank[idx]['text'] if parts[0]=='banking77' else clinc[parts[1]][idx][0]
classification['result']['description']='Read a customer request and choose its intent. BANKING77 covers 77 banking intents. CLINC includes unsupported requests, where the right answer is “out of scope”. The simple baseline uses word patterns learned from the training split.'
write('classify',classification)
classification['result']['source_url']='https://github.com/PolyAI-LDN/task-specific-datasets/tree/'+manifest['PolyAI-LDN/task-specific-datasets']['commit']
write('classify',classification)
for name in ['routing','verify','search','ui','visuals','music','logos','language']:
 d=read(name);result=d['result']
 rows=result.get('rows',result.get('scenes',[]))
 result['availability']={'planned':len(rows),'completed':sum(not r.get('error') for r in rows),'unavailable':sum(bool(r.get('error')) for r in rows)}
 write(name,d)
print('Embedded full JudgeBench candidates; enriched robustness and classification inputs.')
