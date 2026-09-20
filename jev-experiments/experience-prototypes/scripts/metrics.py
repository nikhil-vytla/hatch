"""Recompute derived measurements after resumptions, keeping initial-run measurements."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('../src').resolve()))
from jev_lab.records import read_record,write_record
from jev_lab.metrics import classification,paired_bootstrap
for name in ['classify','judge','robustness','routing','visuals']:
 path=Path('results')/(name+'.jsonl')
 if not path.exists():continue
 doc=read_record(path);r=doc['result']
 if name=='classify':
  for e in r['experiments'].values():
   e.setdefault('initial_metrics',{'jev':e['jev'],'paired_difference':e['paired_difference']})
   e['jev']=classification(e['rows'])
   baseline={x['id']:x for x in e['baseline_rows']}
   e['paired_difference']=paired_bootstrap([x.get('prediction')==baseline[x['id']]['target'] for x in e['rows']],[baseline[x['id']]['prediction']==baseline[x['id']]['target'] for x in e['rows']])
 elif name in ['judge','routing']:
  r.setdefault('initial_metrics',r['metrics']);r['metrics']=classification(r['rows'])
  if name=='judge':
   r['atomic_metrics']=classification([{**x,'prediction':x['atomic_prediction'],'probabilities':None} if 'atomic_prediction' in x else x for x in r['rows']])
   pairs={}
   for x in r['rows']:
    if not x.get('error') and 'prediction' in x:pairs.setdefault(x['pair_id'],{})[x['swap']]=x['prediction']
   both=[v for v in pairs.values() if len(v)==2]
   r['order_disagreement_rate']=sum(v[False]==v[True] for v in both)/len(both) if both else None
 elif name=='robustness':
  r.setdefault('initial_variants',r['variants']);r['metrics']=classification(r['rows'])
  r['variants']={v:classification([x for x in r['rows'] if x.get('variant',x['id'].split('/')[-1])==v]) for v in ['original','repeat','reverse_options','distractor','quoted_injection']}
 else:r['checks']['valid_scenes']=sum('scene' in x and not x.get('error') for x in r['scenes'])
 rows=[x for e in r['experiments'].values() for x in e['rows']] if name=='classify' else r.get('rows',r.get('scenes',[]))
 r['availability']={'planned':len(rows),'completed':sum(not x.get('error') for x in rows),'unavailable':sum(bool(x.get('error')) for x in rows)}
 r['recovery']['recovered_cases']=sum(bool(x.get('original_error')) for x in rows)
 # Timing and cost in `transport` describe the original run only. New attempts have separate logs.
 r['recovery']['reported_usd']=sum(float(x.get('cost_usd') or 0) for x in r['recovery']['attempts'] if x['status']=='completed')
 write_record(path,doc)
 print(name,r['availability'])
