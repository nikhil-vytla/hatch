#!/usr/bin/env python3
"""Serialized local frozen Laya routing classification. No cloud fallback."""
import hashlib,json,pathlib,subprocess,time
HERE=pathlib.Path(__file__).resolve().parent
out=HERE/'local.jsonl'
existing={json.loads(line)['taskId'] for line in out.read_text().splitlines()} if out.exists() else set()
for task in json.loads((HERE/'tasks.json').read_text()):
 if task['id'] in existing:continue
 categories=['bug-fix','test-writing','repository-analysis','writing','other']
 request={'schemaVersion':'1','requestId':task['id']+'-classification','state':{'prompt':task['prompt'],'context':task['context']},'questions':[{'id':'category','kind':'choice','prompt':'Which category best describes the requested work?','options':[{'id':c,'label':c.replace('-',' ')} for c in categories]},{'id':'difficulty','kind':'ordinal','prompt':'Rate required reasoning difficulty: 0 is a direct mechanical edit; 1 is demanding multistep reasoning. Use the whole task, not its length.','min':0,'max':1,'step':0.25}]}
 started=time.monotonic()
 try:
  proc=subprocess.run(['/tmp/jev-local-fresh-test/bin/jev-local','decide','--model','laya-base-experimental','--data','/tmp/jev-local-model-test','-'],input=json.dumps(request),text=True,capture_output=True,timeout=180)
  response=json.loads(proc.stdout);row={'taskId':task['id'],'split':task['split'],'durationMs':(time.monotonic()-started)*1000,'exitCode':proc.returncode,'request':request,'response':response,'costUsd':0,'costBasis':'Zero marginal API charge; excludes hardware and energy.'}
 except Exception as error:row={'taskId':task['id'],'split':task['split'],'durationMs':(time.monotonic()-started)*1000,'request':request,'status':'error','error':type(error).__name__,'costUsd':0}
 with out.open('a') as f:f.write(json.dumps(row)+'\n')
 print(json.dumps({'taskId':task['id'],'status':row.get('response',{}).get('status',row.get('status')),'durationMs':round(row['durationMs'])}),flush=True)
