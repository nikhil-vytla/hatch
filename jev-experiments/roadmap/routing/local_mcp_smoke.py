#!/usr/bin/env python3
"""Actual MCP-to-installed-MLX smoke; run only while the shared GPU is idle."""
import argparse,json,os,pathlib,selectors,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--executable',required=True);parser.add_argument('--model',required=True);parser.add_argument('--data',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
with tempfile.TemporaryDirectory(prefix='jev-local-mcp-') as directory:
 config=pathlib.Path(directory)/'router.json';config.write_text(json.dumps({'routes':[],'policy':{'weights':{'quality':1,'cost':0,'latency':0},'allowedTools':[],'localOnly':True,'allowAvailabilityFallback':False,'allowQualityEscalation':False,'maxAttempts':1},'localRuntime':{'executable':args.executable,'model':args.model,'dataDirectory':args.data}}))
 proc=subprocess.Popen(['bun',str(HERE/'mcp.ts')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'JEV_ROUTER_CONFIG':str(config)})
 selection=selectors.DefaultSelector();selection.register(proc.stdout,selectors.EVENT_READ)
 def call(message):
  start=time.monotonic();proc.stdin.write(json.dumps(message)+'\n');proc.stdin.flush()
  if not selection.select(120):raise TimeoutError('Local MCP did not return in120seconds')
  line=proc.stdout.readline()
  if not line:raise RuntimeError('Local MCP exited: '+proc.stderr.read())
  return {'request':message,'response':json.loads(line),'wallMs':(time.monotonic()-start)*1000}
 results=[]
 try:
  results.append(call({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','clientInfo':{'name':'local-mcp-smoke','version':'1'}}}))
  request={'schemaVersion':'1','requestId':'synthetic-local-smoke','state':'The parcel arrived today.','questions':[{'id':'arrived','kind':'boolean','prompt':'Has the parcel arrived?'}]}
  results.append(call({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'decide','arguments':{'request':request}}}))
  results.append(call({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'classify_eml','arguments':{'eml':'Subject: Receipt for order123\nContent-Type: text/plain\n\nPayment received. Here is your receipt.\n'}}}))
 finally:
  proc.stdin.close();proc.wait(timeout=10);selection.close()
 report={'condition':'Actual local MCP-to-MLX invocation, explicit experimental model; synthetic typed question and supplied email. Smoke only, not calibration or benchmark evidence.','model':args.model,'runtime':args.executable,'dataDirectory':args.data,'exitCode':proc.returncode,'stderr':proc.stderr.read(),'calls':results}
 pathlib.Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
 statuses=[item['response']['result']['structuredContent']['status'] for item in results[1:]]
 print(json.dumps({'model':args.model,'statuses':statuses,'wallMs':[round(item['wallMs'],2) for item in results[1:]]}))
 assert statuses==['ok','ok'] and proc.returncode==0
