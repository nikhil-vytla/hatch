#!/usr/bin/env python3
"""Real clients receive a malformed destination answer and retain source unchanged."""
import json,pathlib,tempfile,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import run_harness as fixture
class Malformed(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  body=json.dumps({'model':'malformed-fixture','choices':[{'message':{'content':'MALFORMED_FIXTURE_PAYLOAD'}}],'usage':{'prompt_tokens':1,'completion_tokens':1}}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
http=ThreadingHTTPServer(('127.0.0.1',0),Malformed);threading.Thread(target=http.serve_forever,daemon=True).start()
root=pathlib.Path(tempfile.mkdtemp(prefix='jev-malformed-'));fixture.ROUTER=root/'router.json'
fixture.ROUTER.write_text(json.dumps({'routes':[{'id':'malformed-local','model':'malformed-fixture','available':True,'local':True,'capabilities':['text','coding'],'tools':[],'contextTokens':10000,'maxOutputTokens':4096,'quality':{'value':0.5,'basis':'simulation','evidence':'Malformed output fixture'},'latencyMs':{'value':1,'basis':'simulation','evidence':'No performance claim'},'pricing':None,'destination':{'kind':'openai-compatible','endpoint':f'http://127.0.0.1:{http.server_port}'}}],'policy':{'weights':{'quality':1,'cost':0,'latency':0},'allowedTools':[],'localOnly':True,'allowAvailabilityFallback':False,'allowQualityEscalation':False,'maxAttempts':1}}))
fixture.PROMPT='''This is a malformed-output integration fixture. Read sum.ts and sum.test.ts, then ACTUALLY call the Jev route_task MCP tool exactly once with id malformed-fixture, prompt asking for a bug fix, complete source in context and outputTokens128. The destination deliberately returns malformed output. Inspect the returned status and raw output. Do not retry or change routing restrictions. Do not fix, edit, or apply anything to sum.ts or any test file when no usable artifact is returned. Write ANALYSIS.md recording the tool error and why you left the source unchanged. Existing failing tests are expected; you may run them but do not repair them. Do not edit config files.'''
try:
 for name in ['opencode','claude','codex']:
  evidence=fixture.HERE/'evidence'/('malformed-'+name)
  if evidence.exists():raise RuntimeError('Preserve existing evidence before another run')
  fixture.run(name,180,evidence_name='malformed-'+name)
  summary=json.loads((evidence/'summary.json').read_text());summary['sourceUnchanged']=(evidence/'host.diff').read_text()=='';summary['expectedTestsFail']=True;summary['purpose']='Actual client handling of one deterministic malformed loopback destination response.'
  (evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
finally:http.shutdown()
