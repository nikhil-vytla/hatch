#!/usr/bin/env python3
"""Observe each actual client cancelling an active MCP call to a delayed local fixture."""
import json,os,pathlib,signal,subprocess,tempfile,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from run_harness import HERE,MCP,safe_lines
class Delayed(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')));time.sleep(30)
  body=json.dumps({'model':'delayed-fixture','choices':[{'message':{'content':'{"kind":"answer","text":"late"}'}}]}).encode()
  try:self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
  except (BrokenPipeError,ConnectionResetError):pass
http=ThreadingHTTPServer(('127.0.0.1',0),Delayed);threading.Thread(target=http.serve_forever,daemon=True).start()
for name in ['opencode','claude','codex']:
 directory=pathlib.Path(tempfile.mkdtemp(prefix='jev-cancel-'+name+'-'));evidence=HERE/'evidence'/('cancel-'+name);evidence.mkdir(parents=True,exist_ok=True);audit=evidence/'mcp-audit.jsonl'
 if audit.exists():raise RuntimeError('Preserve prior cancellation evidence before running again')
 config=directory/'router.json';config.write_text(json.dumps({'routes':[{'id':'delayed-local','model':'delayed-fixture','available':True,'local':True,'capabilities':['text'],'tools':[],'contextTokens':10000,'maxOutputTokens':4096,'quality':{'value':0.5,'basis':'simulation','evidence':'Delayed cancellation fixture'},'latencyMs':{'value':30000,'basis':'simulation','evidence':'Deterministic artificial wait'},'pricing':None,'destination':{'kind':'openai-compatible','endpoint':f'http://127.0.0.1:{http.server_port}'}}],'policy':{'weights':{'quality':1,'cost':0,'latency':0},'allowedTools':[],'localOnly':True,'allowAvailabilityFallback':False,'allowQualityEscalation':False,'maxAttempts':1}}))
 server_env={'JEV_ROUTER_CONFIG':str(config),'JEV_MCP_AUDIT':str(audit)};env={**os.environ,**server_env};server={'command':'bun','args':[str(MCP)],'env':server_env};mcp=directory/'mcp.json';mcp.write_text(json.dumps({'mcpServers':{'jev':server}}))
 prompt='Call the configured Jev route_task MCP tool exactly once with task {"id":"cancel-fixture","prompt":"Return an answer about cancellation","context":"Synthetic delayed fixture, no private content","outputTokens":128}. Do not execute commands or edit files. Wait for the tool result. This is a client cancellation test.'
 if name=='opencode':
  env['OPENCODE_CONFIG_CONTENT']=json.dumps({'share':'disabled','snapshot':False,'autoupdate':False,'permission':{'*':'deny','jev_*':'allow'},'mcp':{'jev':{'type':'local','command':['bun',str(MCP)],'enabled':True,'environment':server_env,'timeout':120000}}})
  command=['opencode','run','--dir',str(directory),'--pure','--format','json','--model','amazon-bedrock/global.anthropic.claude-fable-5-1']
 elif name=='claude':command=['claude','--bare','--strict-mcp-config','--mcp-config',str(mcp),'--model','claude-sonnet-4-6','--tools','','--allowedTools','mcp__jev__route_task','--output-format','stream-json','--verbose','--no-session-persistence','-p']
 else:command=['codex','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--sandbox','read-only','-c','approval_policy="never"','-c','mcp_servers.jev.tools.route_task.approval_mode="approve"','-c','mcp_servers.jev.command="bun"','-c','mcp_servers.jev.args='+json.dumps([str(MCP)]),'-c','mcp_servers.jev.env='+json.dumps(server_env).replace(': ',' = '),'-']
 started=time.monotonic();proc=subprocess.Popen(command,cwd=directory,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);proc.stdin.write(prompt);proc.stdin.close();proc.stdin=None
 invoked=False
 while proc.poll() is None and time.monotonic()-started<90:
  events=[json.loads(l) for l in audit.read_text().splitlines()] if audit.exists() else []
  if any(e['event']=='tools/call' for e in events):invoked=True;break
  time.sleep(.1)
 if invoked:time.sleep(.25);proc.send_signal(signal.SIGINT)
 try:stdout,stderr=proc.communicate(timeout=10)
 except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGTERM);stdout,stderr=proc.communicate(timeout=5)
 time.sleep(.2)
 events=[json.loads(l) for l in audit.read_text().splitlines()] if audit.exists() else []
 result={'harness':name,'command':command,'invokedBeforeInterrupt':invoked,'exitCode':proc.returncode,'elapsedSeconds':time.monotonic()-started,'serverSawCancellation':any(e['event']=='cancelled' for e in events),'serverSawDisconnect':any(e['event']=='client-disconnected' for e in events),'cancelledToolResult':any(e['event']=='tools/result' and e.get('status')=='cancelled' for e in events),'lateSuccessApplied':False,'hostExitedBeforeScheduledReply':time.monotonic()-started<30,'evidenceBoundary':'No files can be edited; destination is a deterministic delayed loopback fixture, not a live model. Absence of a server notification is not proof that a cancellation notification was sent.'}
 (evidence/'summary.json').write_text(json.dumps(result,indent=2)+'\n');(evidence/'stdout.jsonl').write_text(safe_lines(stdout));(evidence/'stderr.txt').write_text(safe_lines(stderr));print(json.dumps(result),flush=True)
http.shutdown()
